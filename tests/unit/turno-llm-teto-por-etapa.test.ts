/**
 * O TURNO DO LLM TEM PRAZO — provider pendurado vira falha tratada, não espera.
 *
 * ## O defeito
 *
 * As chamadas de modelo do turno (`inbound-turn.ts`: abertura, correção do turno
 * mudo e fechamento) iam ao provider sem prazo nenhum: o `fetch` contido de
 * `providers.ts` não tem timeout e o AI SDK não impõe um por padrão. Um provider
 * que aceita a conexão e não responde prendia o turno até o
 * `QUEUE_VISIBILITY_TIMEOUT_MS` (600 s) da fila — e aí o job era re-claimado
 * enquanto o primeiro ainda podia acordar.
 *
 * ## O que este arquivo prova
 *
 * Pelo SEAM (`runModelCall`, pool fingido, AI SDK de verdade): um provider que
 * nunca responde — mas honra o sinal de abort, como o `fetch` faz — é abortado
 * exatamente no teto da etapa, a falha vira linha em `llm_calls` e o erro SOBE
 * para quem chamou (no turno: `failJob`, re-tentativa com backoff). E que o
 * turno de fato passa o teto nas três chamadas.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TETO_POR_ETAPA_DO_TURNO_MS } from "@/lib/agent-engine/agent/inbound-turn";
import { normalizarErro, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "55555555-5555-4555-8555-555555555555";

function poolFalso() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-da-org",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

/**
 * Provider que aceita o pedido e nunca responde. Honra o `abortSignal` do mesmo
 * jeito que o `fetch` nativo: rejeita com o motivo do abort. Sem honrar o sinal
 * nenhum prazo do mundo o soltaria — e o `fetch` real honra.
 */
function registryPendurado() {
  const pedidos: AbortSignal[] = [];
  const fabrica = (_apiKey: string, modelId: string) =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId,
      supportedUrls: {},
      doGenerate: (opts: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const sinal = opts.abortSignal;
          if (sinal) pedidos.push(sinal);
          sinal?.addEventListener("abort", () => reject(sinal.reason), { once: true });
        }),
    }) as never;
  return { registry: { anthropic: fabrica }, pedidos };
}

const cfg = {
  anthropicApiKey: "chave-anthropic",
  openaiApiKey: "chave-openai",
  cacheTtl: "1h" as const,
};

function chamar(tetoPorEtapaMs: number | undefined) {
  const { pool, inserts } = poolFalso();
  const { registry, pedidos } = registryPendurado();
  const promessa = runModelCall(
    pool,
    cfg,
    {
      tenantId: ORG,
      purpose: "agent_turn",
      messages: [{ role: "user", content: "oi" }],
      maxSteps: 8,
      ...(tetoPorEtapaMs !== undefined ? { tetoPorEtapaMs } : {}),
    },
    { registry },
  );
  // Observa o desfecho sem deixar rejeição solta enquanto os timers andam.
  const desfecho = promessa.then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  return { desfecho, inserts, pedidos };
}

describe("teto por etapa nas chamadas de modelo do turno", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("provider que nunca responde é abortado no teto e a falha sobe registrada", async () => {
    const { desfecho, inserts, pedidos } = chamar(TETO_POR_ETAPA_DO_TURNO_MS);
    let terminou = false;
    void desfecho.then(() => {
      terminou = true;
    });

    // Um tique antes do teto: a chamada segue esperando — o prazo não é menor
    // do que o declarado.
    await vi.advanceTimersByTimeAsync(TETO_POR_ETAPA_DO_TURNO_MS - 1);
    expect(pedidos).toHaveLength(1);
    expect(terminou).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const r = await desfecho;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // O sinal chegou ao provider (é ele que derruba o `fetch` de verdade).
    expect(pedidos[0]!.aborted).toBe(true);
    expect(String((r.e as Error).message)).toMatch(/timeout/i);
    // Classificada como indisponibilidade do provedor — a tela de Execuções
    // explica, e não vira "erro desconhecido".
    expect(normalizarErro(r.e).error_code).toBe("provedor_indisponivel");
    // Caminho de erro do seam: a falha virou linha em llm_calls ANTES de subir.
    expect(inserts).toHaveLength(1);
  });

  it("controle: sem o teto, a mesma chamada continua pendurada além do prazo da fila", async () => {
    const { desfecho } = chamar(undefined);
    let terminou = false;
    void desfecho.then(() => {
      terminou = true;
    });

    await vi.advanceTimersByTimeAsync(600_000 + 1);
    expect(terminou).toBe(false);
  });
});

describe("o turno passa o teto nas três chamadas de modelo", () => {
  const fonte = readFileSync(
    path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );

  it("cada runModelCall do turno carrega tetoPorEtapaMs", () => {
    // Um bloco por chamada: do `runModelCall(` até o fechamento dos deps.
    const chamadas = fonte.split("await runModelCall(").slice(1);
    expect(chamadas).toHaveLength(3);
    for (const corpo of chamadas) {
      const ateDeps = corpo.slice(0, corpo.indexOf("{ registry: deps.registry"));
      expect(ateDeps).toContain("tetoPorEtapaMs: TETO_POR_ETAPA_DO_TURNO_MS");
    }
  });

  it("o teto fica bem abaixo do prazo de visibilidade da fila (600 s)", () => {
    expect(TETO_POR_ETAPA_DO_TURNO_MS).toBeGreaterThanOrEqual(90_000);
    expect(TETO_POR_ETAPA_DO_TURNO_MS * 4).toBeLessThan(600_000);
  });
});
