import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O webhook da Meta não perde a mensagem quando a ingestão falha.
 *
 * Antes: as rotas do canal por QR, da cobrança, da Nuvemshop e a genérica de
 * canal gravavam o corpo cru em `webhook_events_log` antes de processar; a da
 * Meta não gravava nada. Quando `ingestMetaInbound` devolvia `failed`, a rota
 * respondia 200 (para a Meta não reentregar em loop) e escrevia um
 * `console.error` — e a mensagem do cliente sumia, sem corpo guardado em lugar
 * nenhum e sem ninguém que a tentasse de novo.
 *
 * Agora, medido pelo que a rota GRAVA e pelo que o cron `webhook-replay` FAZ:
 *   - o corpo cru entra no arquivo antes do processamento, na organização do
 *     TOKEN do path (nunca a do corpo), sem cabeçalho de credencial;
 *   - `failed` deixa a linha `error` com `transitoria:` — o mesmo marcador que o
 *     cron já relê para o canal por QR;
 *   - o cron reprocessa a linha da Meta pela MESMA ingestão e a fecha `processed`.
 */

const APP_SECRET = "app-secret-de-teste";
const SESSAO = {
  id: "sess-meta-1",
  organizationId: "org-do-token",
  wabaId: "waba-1",
  provider: "meta_cloud",
};

interface Op {
  tabela: string;
  op: "insert" | "update" | "select";
  valores?: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
}
const ops: Op[] = [];
let arquivoPendente: Record<string, unknown>[] = [];
/** A linha de `channel_sessions` que o cron acha para a linha arquivada. */
let sessaoDoArquivo: Record<string, unknown> | null = null;

function consulta(tabela: string, op: Op["op"], valores?: Record<string, unknown>) {
  const registro: Op = { tabela, op, filtros: [], ...(valores ? { valores } : {}) };
  ops.push(registro);
  const resultado = () => {
    if (op === "update") return { data: null, error: null };
    if (op === "insert") return { data: { id: `${tabela}-novo` }, error: null };
    if (tabela === "webhook_events_log") return { data: arquivoPendente, error: null };
    if (tabela === "channel_sessions") return { data: sessaoDoArquivo, error: null };
    return { data: null, error: null };
  };
  const q: Record<string, unknown> = {};
  for (const f of ["eq", "neq", "like", "lt", "is", "in", "or"]) {
    q[f] = (col: string, v: unknown) => {
      registro.filtros.push([`${f}:${col}`, v]);
      return q;
    };
  }
  q.order = () => q;
  q.limit = () => q;
  q.select = () => q;
  q.maybeSingle = async () => resultado();
  q.then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(resultado()).then(ok, ko);
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: (v: Record<string, unknown>) => consulta(tabela, "insert", v),
      update: (v: Record<string, unknown>) => consulta(tabela, "update", v),
      select: () => consulta(tabela, "select"),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("@/lib/channels/meta/session", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  metaSessionByWebhookToken: async () => SESSAO,
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: APP_SECRET, verifyToken: "vt" }),
}));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  // Executa a consulta de verdade no dublê, para os filtros ficarem registrados.
  queryTolerantToMissingArchived: async (comFiltro: () => PromiseLike<unknown>) => comFiltro(),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

/** O que a ingestão devolve a cada chamada, na ordem; acabou a lista, ingere. */
let roteiro: Array<Record<string, unknown>> = [];
const chamadas: Array<{ externalId: string; organizationId: string }> = [];
vi.mock("@/lib/channels/meta/ingest", () => ({
  ingestMetaEcho: async () => ({ status: "ingested" }),
  ingestMetaAppContactSync: async () => ({ status: "synced", contactId: "c" }),
  ingestMetaInbound: async (
    _a: unknown,
    e: { externalId: string },
    dono: { organizationId: string },
  ) => {
    chamadas.push({ externalId: e.externalId, organizationId: dono.organizationId });
    return roteiro.shift() ?? { status: "ingested", messageId: "m-1", conversationId: "cv-1" };
  },
}));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";
import { reprocessarArquivoDeWebhooks } from "@/lib/channels/reprocessar-arquivo-de-webhook";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O corpo aponta para OUTRA WABA e outro número de propósito no teste de
 * isolamento — aqui ele é o da própria sessão.
 */
function corpoDaMeta(wabaId = "waba-1", wamid = "wamid.FALHOU") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5531900000000", phone_number_id: "pn-1" },
              contacts: [{ profile: { name: "Cliente" }, wa_id: "5531988887777" }],
              messages: [
                {
                  from: "5531988887777",
                  id: wamid,
                  timestamp: "1760000000",
                  type: "text",
                  text: { body: "oi" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

const pedido = (cru: string, extras: Record<string, string> = {}) =>
  ({
    text: async () => cru,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(cru, "utf8").digest("hex")}`,
      authorization: "Bearer nao-pode-ir-pro-arquivo",
      ...extras,
    }),
  }) as never;
const ctx = { params: Promise.resolve({ token: "token-de-teste-0001" }) } as never;

const insercoesNoArquivo = () =>
  ops.filter((o) => o.tabela === "webhook_events_log" && o.op === "insert").map((o) => o.valores!);
const desfechosNoArquivo = () =>
  ops.filter((o) => o.tabela === "webhook_events_log" && o.op === "update").map((o) => o.valores!);

beforeEach(() => {
  ops.length = 0;
  chamadas.length = 0;
  roteiro = [];
  arquivoPendente = [];
  sessaoDoArquivo = null;
});

describe("a rota da Meta arquiva o corpo cru antes de processar", () => {
  it("grava a linha `received` com o corpo, na organização do token e sem credencial", async () => {
    const cru = corpoDaMeta();
    const r = await POST(pedido(cru), ctx);
    expect(r.status).toBe(200);

    const [linha, ...resto] = insercoesNoArquivo();
    expect(resto).toEqual([]);
    expect(linha).toMatchObject({
      organization_id: SESSAO.organizationId,
      channel_session_id: SESSAO.id,
      provider: "meta_cloud",
      raw_body: cru,
      status: "received",
    });
    const cabecalhos = linha!.headers as Record<string, string>;
    expect(cabecalhos.authorization).toBeUndefined();
    // A assinatura FICA (é ela que permite reconferir depois), o segredo não.
    expect(cabecalhos["x-hub-signature-256"]).toMatch(/^sha256=/);
    expect(JSON.stringify(linha)).not.toContain(APP_SECRET);
  });

  it("ingestão bem-sucedida fecha a linha `processed`", async () => {
    await POST(pedido(corpoDaMeta()), ctx);
    expect(desfechosNoArquivo()).toContainEqual(expect.objectContaining({ status: "processed" }));
  });

  it("ingestão que falha → 200 para a Meta, e a linha fica `error` com `transitoria:` para o replay", async () => {
    roteiro = [{ status: "failed", reason: "mensagem: statement timeout" }];
    const r = await POST(pedido(corpoDaMeta()), ctx);
    expect(r.status).toBe(200);
    const fechamento = desfechosNoArquivo().at(-1);
    expect(fechamento).toMatchObject({ status: "error" });
    expect(String(fechamento!.error_message)).toMatch(/^transitoria:/);
    expect(String(fechamento!.error_message)).toContain("statement timeout");
  });

  it("`no_session` fecha `error` sem o marcador — reprocessar não muda o número que não é nosso", async () => {
    roteiro = [{ status: "no_session" }];
    await POST(pedido(corpoDaMeta()), ctx);
    const fechamento = desfechosNoArquivo().at(-1);
    expect(fechamento).toMatchObject({ status: "error" });
    expect(String(fechamento!.error_message)).not.toMatch(/^transitoria:/);
  });

  it("assinatura errada também deixa rastro: `error` com `valid_signature: false`", async () => {
    const cru = corpoDaMeta();
    const r = await POST(pedido(cru, { "x-hub-signature-256": "sha256=errada" }), ctx);
    expect(r.status).toBe(401);
    expect(insercoesNoArquivo()).toHaveLength(1);
    expect(desfechosNoArquivo().at(-1)).toMatchObject({ status: "error", valid_signature: false });
    expect(chamadas).toEqual([]);
  });

  it("o corpo que aponta para outra WABA continua arquivado na organização do TOKEN", async () => {
    await POST(pedido(corpoDaMeta("waba-de-outra-org")), ctx);
    expect(insercoesNoArquivo()[0]).toMatchObject({ organization_id: SESSAO.organizationId });
    // E nada é ingerido: o evento é de outra WABA.
    expect(chamadas).toEqual([]);
  });
});

describe("o cron webhook-replay reprocessa a linha da Meta", () => {
  const linhaDaMeta = (organizationId = SESSAO.organizationId) => ({
    id: "log-meta-1",
    organization_id: organizationId,
    channel_session_id: SESSAO.id,
    provider: "meta_cloud",
    payload_parsed: JSON.parse(corpoDaMeta()) as unknown,
    attempts: 0,
    error_message: "transitoria: mensagem: statement timeout",
  });
  const replay = () => reprocessarArquivoDeWebhooks(createAdminClient(), new Date(), "req-cron");

  it("a leitura do cron inclui o provider da Meta", async () => {
    await replay();
    const leitura = ops.find((o) => o.tabela === "webhook_events_log" && o.op === "select");
    expect(leitura?.filtros).toContainEqual([
      "in:provider",
      expect.arrayContaining(["waha", "meta_cloud"]),
    ]);
  });

  it("ponta a ponta: a rota arquiva a falha e o cron a reprocessa com sucesso", async () => {
    roteiro = [{ status: "failed", reason: "mensagem: statement timeout" }];
    const cru = corpoDaMeta();
    await POST(pedido(cru), ctx);
    const arquivada = insercoesNoArquivo()[0]!;
    const marcada = desfechosNoArquivo().at(-1)!;

    // O cron lê a linha como a rota a deixou.
    arquivoPendente = [
      {
        id: "log-meta-1",
        organization_id: arquivada.organization_id,
        channel_session_id: arquivada.channel_session_id,
        provider: arquivada.provider,
        payload_parsed: arquivada.payload_parsed,
        attempts: 0,
        error_message: marcada.error_message,
      },
    ];
    sessaoDoArquivo = {
      id: SESSAO.id,
      organization_id: SESSAO.organizationId,
      meta_waba_id: SESSAO.wabaId,
    };
    ops.length = 0;

    const r = await replay();
    expect(r).toEqual({ lidas: 1, processadas: 1, ainda_falhando: 0, desistidas: 0 });
    expect(chamadas.at(-1)).toEqual({
      externalId: "wamid.FALHOU",
      organizationId: SESSAO.organizationId,
    });
    expect(desfechosNoArquivo()).toContainEqual(expect.objectContaining({ status: "processed" }));
  });

  it("ainda falhando → soma uma tentativa, sem desistir", async () => {
    arquivoPendente = [linhaDaMeta()];
    sessaoDoArquivo = {
      id: SESSAO.id,
      organization_id: SESSAO.organizationId,
      meta_waba_id: SESSAO.wabaId,
    };
    roteiro = [{ status: "failed", reason: "mensagem: statement timeout" }];
    const r = await replay();
    expect(r.ainda_falhando).toBe(1);
    expect(desfechosNoArquivo()).toContainEqual({ attempts: 1 });
  });

  it("a sessão é procurada na organização DA LINHA, e a ingestão roda nela", async () => {
    arquivoPendente = [linhaDaMeta("org-da-linha")];
    sessaoDoArquivo = {
      id: SESSAO.id,
      organization_id: "org-da-linha",
      meta_waba_id: SESSAO.wabaId,
    };
    await replay();
    const busca = ops.find((o) => o.tabela === "channel_sessions" && o.op === "select");
    expect(busca?.filtros).toEqual(
      expect.arrayContaining([
        ["eq:id", SESSAO.id],
        ["eq:organization_id", "org-da-linha"],
        ["eq:provider", "meta_cloud"],
      ]),
    );
    expect(chamadas.at(-1)?.organizationId).toBe("org-da-linha");
  });

  it("canal apagado ou arquivado → `dead`, sem chamar a ingestão", async () => {
    arquivoPendente = [linhaDaMeta()];
    sessaoDoArquivo = null;
    const r = await replay();
    expect(r.desistidas).toBe(1);
    expect(chamadas).toEqual([]);
    expect(desfechosNoArquivo()).toContainEqual(expect.objectContaining({ status: "dead" }));
  });
});
