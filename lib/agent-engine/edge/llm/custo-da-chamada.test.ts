/**
 * O TETO DE GASTO PRECISA ENXERGAR O OPENROUTER.
 *
 * ## O defeito (documentado em `lib/ai/budget/check.ts`, campo `gasto_incompleto`)
 *
 * `pricing.ts` casa o modelo por id EXATO numa tabela estática e devolve `null`
 * para quem está fora dela — e todo id de roteador como `z-ai/glm-4.7` está fora.
 * `llm_calls.cost_cents` ficava nulo, a régua `fn_gasto_de_ia_do_mes` soma
 * `coalesce(cost_cents, 0)`, e numa instalação em OpenRouter o gasto medido era
 * ZERO: o teto nunca disparava e a tela mostrava "US$ 0,00" com o dinheiro saindo.
 *
 * ## O que este arquivo prova
 *
 *  (a) modelo do OpenRouter fora da tabela recebe o custo do CATÁLOGO (`ai_models`,
 *      onde o cron `sync-model-catalog` grava o preço real da OpenRouter);
 *  (b) o custo que o PROVEDOR informa no `usage` da resposta tem precedência;
 *  (c) modelo da tabela estática segue cobrado exatamente como antes;
 *  (d) com o custo conhecido, a régua do orçamento DISPARA — antes não disparava;
 *  e o lado honesto: sem catálogo e sem custo do provedor, segue `null` (é o que
 *  acende `gasto_incompleto` na tela, em vez de um zero inventado).
 */
import type pg from "pg";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { generateText } from "ai";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { decidirOrcamento } from "@/lib/agent-engine/edge/llm/orcamento";
import { costCents, type TokenUsage } from "@/lib/agent-engine/edge/llm/pricing";
import {
  custoDaChamada,
  custoInformadoPeloProvedor,
} from "@/lib/agent-engine/edge/llm/custo-da-chamada";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: () => () => false,
  asSchema: vi.fn(),
  tool: (t: unknown) => t,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

const ORG = "44444444-4444-4444-8444-444444444444";
const MODELO_OPENROUTER = "z-ai/glm-4.7";

/** Preço do catálogo em centavos por MILHÃO (o formato de `ai_models`). */
const CATALOGO_GLM = { input: 60, output: 220 };

const USO: TokenUsage = {
  inputTokens: 10_000,
  outputTokens: 2_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
/** 10k × 60/M + 2k × 220/M = 0,6 + 0,44 = 1,04 centavo. */
const CUSTO_PELO_CATALOGO = 1.04;

type Linha = {
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
};

function dbComCatalogo(linhas: Linha[]) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from ai_models")) {
      const ids = (params[0] as string[]) ?? [];
      return { rows: linhas.filter((l) => ids.includes(l.model_id)) };
    }
    return { rows: [] };
  });
  return { query } as never as pg.Pool & { query: typeof query };
}

const LINHA_GLM: Linha = {
  model_id: MODELO_OPENROUTER,
  input_price_per_million_cents: CATALOGO_GLM.input,
  output_price_per_million_cents: CATALOGO_GLM.output,
};

/** Um passo do generateText com o corpo cru da OpenRouter (`usage.cost` em USD). */
function passoComCusto(usd: number | undefined, extra: Record<string, unknown> = {}) {
  return {
    response: {
      body: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          ...(usd === undefined ? {} : { cost: usd }),
          ...extra,
        },
      },
    },
  };
}

describe("custoInformadoPeloProvedor — o `usage.cost` da OpenRouter", () => {
  it("soma o custo de TODOS os passos do loop de ferramentas, em centavos", () => {
    expect(custoInformadoPeloProvedor([passoComCusto(0.01), passoComCusto(0.0025)])).toBeCloseTo(
      1.25,
      10,
    );
  });

  it("BYOK: soma o que a OpenRouter cobrou e o que o provedor de origem cobrou", () => {
    const passo = passoComCusto(0.001, {
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.02 },
    });
    expect(custoInformadoPeloProvedor([passo])).toBeCloseTo(2.1, 10);
  });

  it("sem corpo, sem passos ou com um passo sem custo → null (não inventa parcial)", () => {
    expect(custoInformadoPeloProvedor(undefined)).toBeNull();
    expect(custoInformadoPeloProvedor([])).toBeNull();
    expect(custoInformadoPeloProvedor([{ response: {} }])).toBeNull();
    expect(custoInformadoPeloProvedor([passoComCusto(0.01), passoComCusto(undefined)])).toBeNull();
    expect(custoInformadoPeloProvedor([passoComCusto(Number.NaN)])).toBeNull();
    expect(custoInformadoPeloProvedor([passoComCusto(-1)])).toBeNull();
  });
});

describe("custoDaChamada — a ordem: provedor > tabela do motor > catálogo > null", () => {
  it("(a) modelo do OpenRouter fora da tabela recebe o custo do catálogo", async () => {
    const db = dbComCatalogo([LINHA_GLM]);
    const r = await custoDaChamada(db, { model: MODELO_OPENROUTER, usage: USO, cacheTtl: "1h" });
    expect(r.fonte).toBe("catalogo");
    expect(r.cents).toBeCloseTo(CUSTO_PELO_CATALOGO, 10);
  });

  it("(a) o catálogo também casa o id sem o prefixo `provider/`, preferindo o exato", async () => {
    const db = dbComCatalogo([
      {
        model_id: "glm-4.7",
        input_price_per_million_cents: 999,
        output_price_per_million_cents: 999,
      },
      LINHA_GLM,
    ]);
    const r = await custoDaChamada(db, { model: MODELO_OPENROUTER, usage: USO, cacheTtl: "1h" });
    expect(r.cents).toBeCloseTo(CUSTO_PELO_CATALOGO, 10);
  });

  it("(b) o custo informado pelo provedor vence a tabela e o catálogo", async () => {
    const db = dbComCatalogo([LINHA_GLM]);
    const r = await custoDaChamada(db, {
      model: MODELO_OPENROUTER,
      usage: USO,
      cacheTtl: "1h",
      steps: [passoComCusto(0.0333)],
    });
    expect(r.fonte).toBe("provedor");
    expect(r.cents).toBeCloseTo(3.33, 10);
    // Vence até a tabela estática: é o que de fato foi debitado.
    const naTabela = await custoDaChamada(db, {
      model: "anthropic/claude-sonnet-5",
      usage: USO,
      cacheTtl: "1h",
      steps: [passoComCusto(0.05)],
    });
    expect(naTabela.fonte).toBe("provedor");
    expect(naTabela.cents).toBeCloseTo(5, 10);
  });

  it("(c) modelo da tabela estática continua igual — e nem consulta o catálogo", async () => {
    const db = dbComCatalogo([LINHA_GLM]);
    for (const model of [
      "claude-sonnet-5",
      "gpt-5.4-mini",
      "gemini-2.5-flash",
      "anthropic/claude-sonnet-5",
    ]) {
      const r = await custoDaChamada(db, { model, usage: USO, cacheTtl: "1h" });
      expect(r.fonte).toBe("tabela");
      expect(r.cents).toBe(costCents(model, USO, "1h"));
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it("sem catálogo e sem custo do provedor → null (a tela segue honesta: gasto incompleto)", async () => {
    const semLinha = await custoDaChamada(dbComCatalogo([]), {
      model: MODELO_OPENROUTER,
      usage: USO,
      cacheTtl: "1h",
    });
    expect(semLinha).toEqual({ cents: null, fonte: "desconhecido" });

    const semPreco = await custoDaChamada(
      dbComCatalogo([
        {
          model_id: MODELO_OPENROUTER,
          input_price_per_million_cents: null,
          output_price_per_million_cents: null,
        },
      ]),
      { model: MODELO_OPENROUTER, usage: USO, cacheTtl: "1h" },
    );
    expect(semPreco.cents).toBeNull();
  });

  it("catálogo que falha não derruba a chamada: custo desconhecido", async () => {
    const db = {
      query: vi.fn(async () => {
        throw new Error("relation ai_models does not exist");
      }),
    } as never;
    const r = await custoDaChamada(db, { model: MODELO_OPENROUTER, usage: USO, cacheTtl: "1h" });
    expect(r).toEqual({ cents: null, fonte: "desconhecido" });
  });
});

// ── Pelo seam inteiro: o que vai para `llm_calls.cost_cents` ──────────────────

function poolOpenRouter(catalogo: Linha[]) {
  const custosGravados: Array<number | null> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "openrouter",
              default_model: MODELO_OPENROUTER,
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_models")) {
      const ids = (params[0] as string[]) ?? [];
      return { rows: catalogo.filter((l) => ids.includes(l.model_id)) };
    }
    if (sql.includes("insert into llm_calls")) {
      custosGravados.push(params[11] as number | null);
      return { rows: [{ id: `call-${custosGravados.length}` }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, custosGravados };
}

const registry = {
  openrouter: () => ({
    specificationVersion: "v3",
    provider: "openrouter",
    modelId: MODELO_OPENROUTER,
  }),
} as never;

function respostaDoModelo(steps: unknown[]) {
  vi.mocked(generateText).mockResolvedValue({
    text: "ok",
    usage: {
      inputTokens: USO.inputTokens,
      outputTokens: USO.outputTokens,
      totalTokens: USO.inputTokens + USO.outputTokens,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    steps,
    response: { id: "r", modelId: MODELO_OPENROUTER, messages: [] },
    responseMessages: [],
    toolCalls: [],
  } as never);
}

async function umTurno(pool: never) {
  return runModelCall(
    pool,
    { openrouterApiKey: "chave-openrouter-de-teste", cacheTtl: "1h" },
    { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
    { registry },
  );
}

describe("runModelCall em OpenRouter grava custo conhecido em llm_calls", () => {
  beforeEach(() => vi.mocked(generateText).mockReset());

  it("pede o corpo da resposta ao SDK — é onde a OpenRouter põe `usage.cost`", async () => {
    respostaDoModelo([passoComCusto(0.002)]);
    const { pool } = poolOpenRouter([]);
    await umTurno(pool);
    const opcoes = vi.mocked(generateText).mock.calls[0]?.[0] as {
      include?: { responseBody?: boolean };
    };
    expect(opcoes.include?.responseBody).toBe(true);
  });

  it("(b) grava o custo do provedor", async () => {
    respostaDoModelo([passoComCusto(0.002)]);
    const { pool, custosGravados } = poolOpenRouter([LINHA_GLM]);
    const r = await umTurno(pool);
    expect(custosGravados).toHaveLength(1);
    expect(custosGravados[0]).toBeCloseTo(0.2, 10);
    expect(r.costCents).toBeCloseTo(0.2, 10);
  });

  it("(a) sem custo no corpo, grava o custo do catálogo — e não mais null", async () => {
    respostaDoModelo([{ response: {} }]);
    const { pool, custosGravados } = poolOpenRouter([LINHA_GLM]);
    await umTurno(pool);
    expect(custosGravados[0]).toBeCloseTo(CUSTO_PELO_CATALOGO, 10);
  });

  it("(d) com o custo conhecido, o teto dispara na régua", async () => {
    // 200 turnos de US$ 0,05 = US$ 10,00 = 1000 centavos, contra um teto de 900.
    respostaDoModelo([passoComCusto(0.05)]);
    const { pool, custosGravados } = poolOpenRouter([LINHA_GLM]);
    for (let i = 0; i < 200; i++) await umTurno(pool);

    // A régua é `coalesce(sum(cost_cents), 0)` — a mesma conta, aqui.
    const gastoCents = custosGravados.reduce<number>((s, c) => s + (c ?? 0), 0);
    expect(gastoCents).toBeCloseTo(1000, 6);

    const veredito = decidirOrcamento({
      modo: "bloquear",
      tetoCents: 900,
      gastoCents,
      efetivoEm: new Date("2026-10-01T00:00:00Z"),
      agora: new Date("2026-10-14T12:00:00Z"),
      purpose: "agent_preview",
      chave: "on",
      limiarPct: 80,
      avisadoNesteMes: true,
    });
    expect(veredito).toEqual({ acao: "bloquear", porque: "teto_atingido" });
  });
});
