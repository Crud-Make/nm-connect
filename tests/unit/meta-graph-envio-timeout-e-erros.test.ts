/**
 * Envio pela Graph: TEMPO DE ESPERA e TRATAMENTO POR CÓDIGO, pela porta real.
 *
 * Dois defeitos, provados do adapter até a linha de `messages`:
 *
 * C2 — o `fetch` do envio não tinha `signal`. Uma Graph que pendura a conexão
 * segurava o turno do agente e a request para sempre. O desfecho certo é
 * `failed` com motivo legível (`meta_timeout`), UMA chamada só e NENHUMA nova
 * tentativa automática: abortar a espera não prova que a Meta não entregou.
 *
 * C4 — todo erro da Graph virava o genérico `meta_error`. 190 (token inválido)
 * é a CONEXÃO parada, não a mensagem, e precisa aparecer na tela; 130429/131056
 * são limite de vazão, recusados antes de existir wamid — temporários.
 *
 * O tempo de espera é provado sem esperar 25 s: `AbortSignal.timeout` é
 * espionado — o teste confere que o envio PEDIU o teto do módulo e o troca por
 * um de poucos milissegundos, de modo que o `fetch` que nunca resolve é
 * abortado de verdade, pelo mesmo caminho de produção.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { getAdapter } from "@/lib/channels";
import { ErroDeEnvioDoCanal } from "@/lib/channels/erro-de-envio";
import { GRAPH_TIMEOUT_ENVIO_MS } from "@/lib/channels/meta/erros-da-graph";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const registrarCredencial = vi.fn(async (_input: unknown) => "avisado" as const);
vi.mock("@/lib/channels/credencial-recusada-no-envio", () => ({
  registrarCredencialRecusadaNoEnvio: (...args: unknown[]) =>
    (registrarCredencial as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Sessão sem credencial gravada: o adapter cai no ambiente (META_*), que o
// teste estabelece. O `from` encadeável devolve "nenhuma linha".
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const alvo: Record<string, unknown> = {
      maybeSingle: async () => ({ data: null, error: null }),
    };
    alvo.select = () => alvo;
    alvo.eq = () => alvo;
    alvo.is = () => alvo;
    return { from: () => alvo, rpc: async () => ({ data: null, error: null }) };
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "req-1",
};
const texto = { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput;

function conversaOficial() {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    provider_conversation_id: null,
    contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
    channel_sessions: {
      provider: "meta_cloud",
      waha_session_name: null,
      meta_phone_number_id: "1103328999528818",
      status: "WORKING",
      archived_at: null,
    },
  };
}

/** `fetch` que NUNCA responde — só termina se o sinal abortar. */
function fetchQuePendura() {
  const spy = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sinal = init?.signal;
        if (!sinal) return; // sem sinal: pendura para sempre (o defeito)
        if (sinal.aborted) return reject(sinal.reason);
        sinal.addEventListener("abort", () => reject(sinal.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function fetchComErro(code: number, status = 400) {
  const spy = vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ error: { code, message: `erro ${code}` } }),
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Troca o teto pedido por um curtíssimo, e guarda quanto foi pedido. */
function tetoEncurtado() {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const pedidos: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    pedidos.push(ms);
    return original(15);
  });
  return pedidos;
}

/** Corrida contra o relógio: sem o teto, o envio nunca termina. */
async function emAte<T>(p: Promise<T>, ms = 2_000): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`não terminou em ${ms} ms — envio sem teto de espera`)), ms);
  });
  try {
    return await Promise.race([p, limite]);
  } finally {
    clearTimeout(t);
  }
}

beforeEach(() => {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  registrarCredencial.mockClear();
});

describe("adapter oficial — teto de espera no envio (C2)", () => {
  it("Graph pendurada: aborta no teto do módulo, lança meta_timeout incerta, UMA chamada", async () => {
    const pedidos = tetoEncurtado();
    const spy = fetchQuePendura();

    const erro = await emAte(
      getAdapter("meta_cloud")
        .send({
          organizationId: ORG,
          sessionRef: "x",
          to: "5531999998888",
          kind: "text",
          body: "oi",
        })
        .then(
          () => null,
          (e: unknown) => e,
        ),
    );

    expect(erro).toBeInstanceOf(ErroDeEnvioDoCanal);
    expect(erro).toMatchObject({ codigo: "meta_timeout", natureza: "incerta" });
    expect(pedidos).toContain(GRAPH_TIMEOUT_ENVIO_MS);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("adapter oficial — erro classificado por código (C4)", () => {
  it.each([
    [190, "meta_token_invalido", "credencial"],
    [130429, "meta_limite_de_envio", "temporaria"],
    [131056, "meta_limite_do_par", "temporaria"],
    [131009, "meta_error", "permanente"],
  ])("code %i → %s (%s), mensagem no formato de sempre", async (code, codigo, natureza) => {
    fetchComErro(code);
    const erro = await getAdapter("meta_cloud")
      .send({ organizationId: ORG, sessionRef: "x", to: "5531", kind: "text", body: "oi" })
      .catch((e: unknown) => e);
    expect(erro).toMatchObject({ codigo, natureza });
    expect((erro as Error).message).toMatch(new RegExp(`^meta_${code}: erro ${code}`));
  });
});

describe("sendMessageHandler pelo canal oficial — desfecho na linha", () => {
  it("timeout: failed com meta_timeout e entrega_incerta, sem segunda chamada", async () => {
    tetoEncurtado();
    const spy = fetchQuePendura();
    const { supabase } = criarDubleDoHandler({ conversation: conversaOficial() });

    const msg = await emAte(sendMessageHandler(supabase, ctx, texto));

    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("meta_timeout");
    expect(msg.error_message).toMatch(/não foi reenviada/);
    expect((msg.metadata as Record<string, unknown>).entrega_incerta).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(registrarCredencial).not.toHaveBeenCalled();
  });

  it("190: failed com meta_token_invalido E a sessão é marcada para a tela", async () => {
    fetchComErro(190, 401);
    const { supabase } = criarDubleDoHandler({ conversation: conversaOficial() });

    const msg = await sendMessageHandler(supabase, ctx, texto);

    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("meta_token_invalido");
    expect(registrarCredencial).toHaveBeenCalledTimes(1);
    expect(registrarCredencial).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, channelSessionId: SESSION }),
    );
  });

  it("130429: classificado como temporário — código próprio, sem marcar a sessão", async () => {
    fetchComErro(130429);
    const { supabase } = criarDubleDoHandler({ conversation: conversaOficial() });

    const msg = await sendMessageHandler(supabase, ctx, texto);

    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("meta_limite_de_envio");
    expect((msg.metadata as Record<string, unknown> | null)?.entrega_incerta).toBeUndefined();
    expect(registrarCredencial).not.toHaveBeenCalled();
  });

  it("falha em marcar a sessão não impede a mensagem de terminar failed", async () => {
    fetchComErro(190, 401);
    registrarCredencial.mockRejectedValueOnce(new Error("banco fora"));
    const { supabase } = criarDubleDoHandler({ conversation: conversaOficial() });

    const msg = await sendMessageHandler(supabase, ctx, texto);

    expect(msg.status).toBe("failed");
    expect(msg.error_code).toBe("meta_token_invalido");
  });
});
