import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as FalhaDeEntrega from "@/lib/messaging/falha-de-entrega";

/**
 * O status de uma mensagem que ENVIAMOS não regride, e o carimbo é a hora do
 * EVENTO — pela rota inteira, contra uma linha em memória.
 *
 * A Meta reentrega tudo o que não recebe 2xx e não garante ordem entre
 * `sent`/`delivered`/`read`/`failed`. Antes desta correção o ramo de
 * sent/delivered/read fazia UM update sem guarda nenhuma:
 *
 *   - `failed` seguido de um `delivered` atrasado reabria a linha como `sent`;
 *   - `delivered_at`/`read_at` eram a hora de RECEBIMENTO do webhook, e cada
 *     reentrega empurrava o carimbo para frente.
 *
 * O dublê do banco aplica de verdade os filtros que a rota encadeia (`eq`,
 * `neq`, `or` com `is.null`/`gt`) — um dublê que só grava a chamada provaria a
 * forma do código, não o efeito na linha.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO = { id: "sess-1", organizationId: ORG, wabaId: "waba-1" };
const APP_SECRET = "app-secret-de-teste";
const WAMID = "wamid.HBgNNTUzMTk5OTk5ODg4OBUCABEYEg";

type Linha = Record<string, unknown>;
const linhas: Linha[] = [];
const emitidas: unknown[] = [];

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => SESSAO,
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: APP_SECRET, verifyToken: "vt" }),
}));
vi.mock("@/lib/messaging/falha-de-entrega", async (original) => ({
  ...(await original<typeof FalhaDeEntrega>()),
  emitirFalhaDeEntrega: async (_admin: unknown, p: unknown) => {
    emitidas.push(p);
  },
}));

/** Um filtro PostgREST, já avaliável contra a linha. */
type Filtro = (l: Linha) => boolean;

function compara(op: string, atual: unknown, valor: string): boolean {
  if (op === "is") return valor === "null" ? atual === null || atual === undefined : false;
  if (atual === null || atual === undefined) return false;
  const v = valor.replace(/^"(.*)"$/, "$1");
  if (op === "gt") return new Date(String(atual)).getTime() > new Date(v).getTime();
  if (op === "lt") return new Date(String(atual)).getTime() < new Date(v).getTime();
  if (op === "eq") return String(atual) === v;
  throw new Error(`operador não suportado pelo dublê: ${op}`);
}

/** `col.op.valor,col.op.valor` → OU dos termos. O valor pode ter `.` dentro. */
function filtroOr(expr: string): Filtro {
  const termos = expr.split(",").map((t) => {
    const [col, op, ...resto] = t.split(".");
    return (l: Linha) => compara(op!, l[col!], resto.join("."));
  });
  return (l) => termos.some((t) => t(l));
}

function dubleDoBanco() {
  return {
    from(tabela: string) {
      if (tabela !== "messages") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        update(patch: Linha) {
          const filtros: Filtro[] = [];
          let quer = false;
          const executa = () => {
            const alvo = linhas.filter((l) => filtros.every((f) => f(l)));
            for (const l of alvo) Object.assign(l, patch);
            return alvo;
          };
          const q = {
            eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
            neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
            or: (expr: string) => (filtros.push(filtroOr(expr)), q),
            select: () => ((quer = true), q),
            maybeSingle: async () => {
              const alvo = executa();
              return { data: quer ? (alvo[0] ?? null) : null, error: null };
            },
            then: (ok: (r: { data: null; error: null }) => unknown) => {
              executa();
              return Promise.resolve({ data: null, error: null }).then(ok);
            },
          };
          return q;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dubleDoBanco() }));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

function pedidoAssinado(cru: string, assinatura?: string) {
  return {
    text: async () => cru,
    headers: new Headers({
      "x-hub-signature-256":
        assinatura ??
        `sha256=${createHmac("sha256", APP_SECRET).update(cru, "utf8").digest("hex")}`,
    }),
  } as never;
}

/** Um `statuses[]` como a Meta manda. `timestamp` é epoch em segundos, string. */
function status(st: string, epochS?: number, erro?: { code: number; title: string }) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: SESSAO.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              statuses: [
                {
                  id: WAMID,
                  status: st,
                  recipient_id: "5531999998888",
                  ...(epochS === undefined ? {} : { timestamp: String(epochS) }),
                  ...(erro ? { errors: [erro] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function chega(corpo: string) {
  const res = await POST(pedidoAssinado(corpo), ctx);
  expect(res.status).toBe(200);
}

const iso = (epochS: number) => new Date(epochS * 1000).toISOString();
const T0 = 1785342000; // envio
const linha = () => linhas[0]!;

beforeEach(() => {
  linhas.length = 0;
  emitidas.length = 0;
  linhas.push({
    id: "msg-1",
    organization_id: ORG,
    external_id: WAMID,
    status: "sent",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    conversation_id: "conv-1",
    contact_id: "ct-1",
    sent_via: "template",
    contacts: { phone_number: "+5531999998888" },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("status da Meta fora de ordem não reabre nem regride a mensagem", () => {
  it("`failed` seguido de `delivered` atrasado NÃO reabre a mensagem como enviada", async () => {
    await chega(status("failed", T0 + 5, { code: 131026, title: "Message Undeliverable" }));
    expect(linha()).toMatchObject({ status: "failed", error_code: "131026" });

    await chega(status("delivered", T0 + 3));

    expect(linha().status).toBe("failed");
    expect(linha().delivered_at).toBeNull();
    expect(linha().error_code).toBe("131026");
  });

  it("a falha continua emitida UMA vez — a reentrega do `failed` não vira segundo aviso", async () => {
    const falha = status("failed", T0 + 5, { code: 131026, title: "Message Undeliverable" });
    await chega(falha);
    await chega(status("delivered", T0 + 3));
    await chega(falha);
    expect(emitidas).toHaveLength(1);
  });

  it("`read` carimba com o timestamp do EVENTO, não com a hora de recebimento", async () => {
    await chega(status("read", T0 + 60));
    expect(linha()).toMatchObject({
      status: "sent",
      read_at: iso(T0 + 60),
      // `read` implica entregue.
      delivered_at: iso(T0 + 60),
    });
  });

  it("reentrega do mesmo `delivered` horas depois NÃO move o carimbo", async () => {
    await chega(status("delivered", T0 + 10));
    vi.setSystemTime(new Date("2026-09-21T19:00:00.000Z"));
    await chega(status("delivered", T0 + 10));
    expect(linha().delivered_at).toBe(iso(T0 + 10));
  });

  it("sem `timestamp`, a reentrega também não move o carimbo da primeira chegada", async () => {
    await chega(status("delivered"));
    const primeiro = linha().delivered_at;
    expect(primeiro).toBe("2026-09-21T15:00:00.000Z");
    vi.setSystemTime(new Date("2026-09-21T19:00:00.000Z"));
    await chega(status("delivered"));
    expect(linha().delivered_at).toBe(primeiro);
  });

  it("`delivered` que chega DEPOIS do `read` corrige a entrega para trás e não toca a leitura", async () => {
    await chega(status("read", T0 + 60));
    await chega(status("delivered", T0 + 10));
    expect(linha()).toMatchObject({ delivered_at: iso(T0 + 10), read_at: iso(T0 + 60) });
  });

  it("`read` posterior não empurra uma entrega já carimbada para frente", async () => {
    await chega(status("delivered", T0 + 10));
    await chega(status("read", T0 + 60));
    expect(linha()).toMatchObject({ delivered_at: iso(T0 + 10), read_at: iso(T0 + 60) });
  });
});

describe("assinatura malformada é 401, nunca 500", () => {
  it("64 caracteres não-hex (o tamanho certo) dão 401", async () => {
    const res = await POST(
      pedidoAssinado(status("delivered", T0), `sha256=${"z".repeat(64)}`),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(linha().delivered_at).toBeNull();
  });
});
