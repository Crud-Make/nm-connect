/**
 * O CUSTO DE UMA CHAMADA DE MODELO, na ordem de quem sabe mais.
 *
 *   1. **O provedor disse.** A OpenRouter devolve `usage.cost` (em dólar) em TODA
 *      resposta de Chat Completions — é o valor debitado da conta, e nenhuma
 *      tabela nossa sabe mais que ele. O `@ai-sdk/openai` descarta o campo no
 *      `usage` normalizado (o schema zod só conhece tokens), então ele é lido do
 *      corpo cru de cada passo (`steps[].response.body`), que o seam pede ao SDK
 *      com `include.responseBody` quando o provedor é a OpenRouter.
 *   2. **A tabela do motor** (`pricing.ts`), com o preço de cache por TTL — é a
 *      régua de Anthropic, OpenAI e Gemini, e segue exatamente como antes.
 *   3. **O catálogo** (`ai_models`), onde o cron `sync-model-catalog` grava o
 *      preço real da OpenRouter (`lib/ai/catalogo/openrouter.ts`). É o mesmo
 *      recurso que `lib/ai/cost.ts` já usa fora do motor. O catálogo não guarda
 *      preço de cache: toda a entrada é cobrada pela tarifa de entrada — erra
 *      para CIMA, que é o lado seguro para um teto de gasto.
 *   4. **Ninguém sabe** → `null`. Nunca zero: zero é "de graça", e é o `null` que
 *      acende `gasto_incompleto` na tela de Uso e orçamento (`lib/ai/budget/check.ts`)
 *      em vez de prometer uma parada que não vai disparar.
 *
 * Antes deste arquivo o motor parava no degrau 2: todo id de roteador fora da
 * tabela (`z-ai/glm-4.7`) gravava `llm_calls.cost_cents` nulo, a régua
 * `fn_gasto_de_ia_do_mes` somava zero e o teto nunca disparava.
 */
import type pg from "pg";

import { costCents, type TokenUsage } from "./pricing";
import type { CacheTtl } from "./stable-prefix";

/** De onde saiu o número — vai para o log, para o operador saber em quem confiar. */
export type FonteDoCusto = "provedor" | "tabela" | "catalogo" | "desconhecido";

export interface CustoDaChamada {
  /** Centavos de DÓLAR, fracionário (coluna `numeric`). `null` = desconhecido. */
  cents: number | null;
  fonte: FonteDoCusto;
}

/** O mínimo de um passo do `generateText` que este módulo lê. */
export interface PassoComCorpo {
  response?: { body?: unknown };
}

function numeroValido(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** USD de UM corpo de resposta, ou null se ele não traz custo. */
function usdDoCorpo(body: unknown): number | null {
  if (body === null || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as { cost?: unknown; is_byok?: unknown; cost_details?: unknown };
  const cost = numeroValido(u.cost);
  if (cost === null) return null;
  // BYOK: `cost` é só a taxa da OpenRouter; a inferência foi cobrada pelo
  // provedor de origem na chave do cliente, e é dinheiro do mesmo bolso.
  if (u.is_byok === true && u.cost_details !== null && typeof u.cost_details === "object") {
    const upstream = numeroValido(
      (u.cost_details as { upstream_inference_cost?: unknown }).upstream_inference_cost,
    );
    if (upstream !== null) return cost + upstream;
  }
  return cost;
}

/**
 * O custo que o provedor informou, somado em todos os passos do loop de
 * ferramentas (o `usage` do resultado também é a soma dos passos), em centavos.
 *
 * Um passo sem custo invalida a soma inteira: meia conta gravada como conta
 * inteira subestima o gasto em silêncio — o defeito que este arquivo conserta.
 */
export function custoInformadoPeloProvedor(
  steps: readonly PassoComCorpo[] | undefined,
): number | null {
  if (!steps || steps.length === 0) return null;
  let usd = 0;
  for (const passo of steps) {
    const doPasso = usdDoCorpo(passo?.response?.body);
    if (doPasso === null) return null;
    usd += doPasso;
  }
  return usd * 100;
}

/**
 * Preço do catálogo, em centavos por MILHÃO de tokens. Duas formas do id: como
 * veio e sem o prefixo `provider/` — a mesma tolerância de `lib/ai/cost.ts` —,
 * preferindo a EXATA (o mesmo id curto pode existir em provedores diferentes).
 */
export const SQL_PRECO_DO_CATALOGO = `
select model_id, input_price_per_million_cents, output_price_per_million_cents
  from ai_models
 where model_id = any($1::text[])
   and deprecated_at is null
 limit 10`;

interface LinhaDoCatalogo {
  model_id: string;
  input_price_per_million_cents: number | string | null;
  output_price_per_million_cents: number | string | null;
}

async function precoDoCatalogo(
  db: Pick<pg.Pool, "query">,
  model: string,
): Promise<{ input: number; output: number } | null> {
  const semPrefixo = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const { rows } = await db.query<LinhaDoCatalogo>(SQL_PRECO_DO_CATALOGO, [[model, semPrefixo]]);
  const linha = rows.find((l) => l.model_id === model) ?? rows[0];
  if (!linha) return null;
  const input = linha.input_price_per_million_cents;
  const output = linha.output_price_per_million_cents;
  // Sem os dois preços não há conta honesta: tratar o que falta como zero seria
  // inventar "de graça" para metade da chamada.
  if (input === null || output === null) return null;
  const i = Number(input);
  const o = Number(output);
  if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return null;
  return { input: i, output: o };
}

export interface EntradaDoCusto {
  model: string;
  usage: TokenUsage;
  cacheTtl: CacheTtl;
  /** Passos do `generateText`, com o corpo cru quando o seam o pediu. */
  steps?: readonly PassoComCorpo[];
  /** Instante da chamada (a virada de tarifa do Gemini Flash). Sem ele, agora. */
  em?: Date;
}

/** O custo da chamada, pela ordem do cabeçalho. Nunca lança. */
export async function custoDaChamada(
  db: Pick<pg.Pool, "query">,
  entrada: EntradaDoCusto,
): Promise<CustoDaChamada> {
  const doProvedor = custoInformadoPeloProvedor(entrada.steps);
  if (doProvedor !== null) return { cents: doProvedor, fonte: "provedor" };

  const daTabela = costCents(
    entrada.model,
    entrada.usage,
    entrada.cacheTtl,
    entrada.em ?? new Date(),
  );
  if (daTabela !== null) return { cents: daTabela, fonte: "tabela" };

  try {
    const preco = await precoDoCatalogo(db, entrada.model);
    if (preco === null) return { cents: null, fonte: "desconhecido" };
    const cents =
      (entrada.usage.inputTokens * preco.input + entrada.usage.outputTokens * preco.output) /
      1_000_000;
    return { cents, fonte: "catalogo" };
  } catch {
    // Catálogo fora do ar (ou um clone sem a tabela) não derruba uma resposta
    // que já foi gerada e paga: o custo fica desconhecido, e a tela diz isso.
    return { cents: null, fonte: "desconhecido" };
  }
}
