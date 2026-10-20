/**
 * QUEM FALA A RESPOSTA — síntese de voz pela OpenAI (`POST /v1/audio/speech`).
 *
 * Conferido na documentação oficial em 20/10/2026
 * (developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
 * e /api/docs/guides/text-to-speech):
 *
 *  - modelo `gpt-4o-mini-tts`, o único dos três que aceita `instructions`
 *    (tom, sotaque, ritmo) — `tts-1`/`tts-1-hd` recusam o campo;
 *  - `input` de até 4096 caracteres (o nosso teto é bem menor, ~1 min de fala:
 *    `LIMITE_DE_CARACTERES_FALADOS`);
 *  - as 13 vozes embutidas de `VOZES_DE_FALA`; a doc recomenda `marin` ou
 *    `cedar` para melhor qualidade — por isso `marin` é a padrão;
 *  - `response_format: "opus"`. A doc não diz o contêiner; na prática a OpenAI
 *    devolve Ogg/Opus, que é o que a Meta exige para a BOLHA de voz
 *    (`voice: true`, `lib/channels/adapters/meta-cloud.ts`). Como a doc não
 *    garante, a resposta é CONFERIDA (`OggS` + `OpusHead`): qualquer outra
 *    coisa vira `formato_invalido` e quem chama manda o texto.
 *
 * O endpoint sem streaming devolve só os bytes do áudio, sem `usage`. O custo
 * é então ESTIMADO (`custoDaSintese`) pelas duas tarifas oficiais, com a
 * duração real lida do próprio Ogg — ver o comentário lá.
 *
 * Nunca lança: todo desfecho é um valor, e o motivo do fracasso é dito.
 */
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";

export const MODELO_DE_FALA = "gpt-4o-mini-tts";

/** As vozes embutidas do `gpt-4o-mini-tts`, na ordem da doc oficial. */
export const VOZES_DE_FALA = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
export type VozDeFala = (typeof VOZES_DE_FALA)[number];

export const VOZ_PADRAO: VozDeFala = "marin";

/** Teto da instrução de tom guardada na versão do agente (o CHECK do banco repete). */
export const LIMITE_DA_INSTRUCAO_DE_TOM = 500;

/**
 * Quanto o turno espera a voz. Acima disso o texto aprovado sai como texto: o
 * cliente que mandou áudio está esperando resposta, não esperando a voz.
 */
export const PRAZO_DA_SINTESE_MS = 20_000;

const ENDERECO = "https://api.openai.com/v1/audio/speech";

export function vozValida(v: string | null | undefined): VozDeFala {
  return (VOZES_DE_FALA as readonly string[]).includes(v ?? "") ? (v as VozDeFala) : VOZ_PADRAO;
}

export type MotivoDaFalhaDaSintese = "prazo_esgotado" | "rede" | "erro_da_api" | "formato_invalido";

export type ResultadoDaSintese =
  | { ok: true; audio: Uint8Array; mime: "audio/ogg"; duracaoSeg: number | null; latenciaMs: number }
  | {
      ok: false;
      motivo: MotivoDaFalhaDaSintese;
      status?: number;
      detalhe: string;
      latenciaMs: number;
    };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function sintetizarFala(entrada: {
  apiKey: string;
  texto: string;
  voz: string | null | undefined;
  instrucoes?: string | null;
  prazoMs?: number;
  fetch?: Fetch;
}): Promise<ResultadoDaSintese> {
  const inicio = Date.now();
  const instrucoes = entrada.instrucoes?.trim().slice(0, LIMITE_DA_INSTRUCAO_DE_TOM);
  const corpo = {
    model: MODELO_DE_FALA,
    input: entrada.texto,
    voice: vozValida(entrada.voz),
    ...(instrucoes ? { instructions: instrucoes } : {}),
    response_format: "opus",
  };
  const fetchFn: Fetch = entrada.fetch ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await fetchFn(ENDERECO, {
      method: "POST",
      headers: { Authorization: `Bearer ${entrada.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(entrada.prazoMs ?? PRAZO_DA_SINTESE_MS),
    });
  } catch (err) {
    const nome = (err as { name?: string } | null)?.name;
    const prazo = nome === "TimeoutError" || nome === "AbortError";
    return {
      ok: false,
      motivo: prazo ? "prazo_esgotado" : "rede",
      detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      latenciaMs: Date.now() - inicio,
    };
  }
  if (!res.ok) {
    // O corpo do erro da OpenAI não traz a chave; mesmo assim, só um trecho curto.
    const detalhe = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, motivo: "erro_da_api", status: res.status, detalhe, latenciaMs: Date.now() - inicio };
  }
  let audio: Uint8Array;
  try {
    audio = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    return {
      ok: false,
      motivo: "rede",
      detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      latenciaMs: Date.now() - inicio,
    };
  }
  if (!ehOggOpus(audio)) {
    return {
      ok: false,
      motivo: "formato_invalido",
      detalhe: `a resposta não é Ogg/Opus (${audio.length} bytes, content-type ${res.headers.get("content-type") ?? "—"})`,
      latenciaMs: Date.now() - inicio,
    };
  }
  return { ok: true, audio, mime: "audio/ogg", duracaoSeg: duracaoDoOggOpus(audio), latenciaMs: Date.now() - inicio };
}

// ─── Ogg/Opus ───────────────────────────────────────────────────────────────

const OGGS = [0x4f, 0x67, 0x67, 0x53];
const OPUS_HEAD = new TextEncoder().encode("OpusHead");

function casaEm(buf: Uint8Array, i: number, padrao: ArrayLike<number>): boolean {
  if (i + padrao.length > buf.length) return false;
  for (let k = 0; k < padrao.length; k++) if (buf[i + k] !== padrao[k]) return false;
  return true;
}

function acharDepois(buf: Uint8Array, padrao: ArrayLike<number>, de = 0, ate = buf.length): number {
  for (let i = de; i <= ate - padrao.length; i++) if (casaEm(buf, i, padrao)) return i;
  return -1;
}

function ehOggOpus(buf: Uint8Array): boolean {
  return casaEm(buf, 0, OGGS) && acharDepois(buf, OPUS_HEAD, 0, Math.min(buf.length, 512)) !== -1;
}

/**
 * Duração em segundos: a granule position da ÚLTIMA página Ogg conta amostras
 * a 48 kHz (RFC 7845 §4), descontado o pre-skip declarado no `OpusHead`.
 * `null` quando o buffer não é Ogg/Opus legível.
 */
export function duracaoDoOggOpus(buf: Uint8Array): number | null {
  if (!ehOggOpus(buf)) return null;
  const head = acharDepois(buf, OPUS_HEAD, 0, Math.min(buf.length, 512));
  const visao = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const preSkip = head + 12 <= buf.length ? visao.getUint16(head + 10, true) : 0;
  let ultima = -1;
  for (let i = buf.length - 4; i >= 0; i--) {
    if (casaEm(buf, i, OGGS)) {
      ultima = i;
      break;
    }
  }
  if (ultima < 0 || ultima + 14 > buf.length) return null;
  const granule = visao.getBigInt64(ultima + 6, true);
  if (granule <= 0n) return null;
  const segundos = (Number(granule) - preSkip) / 48_000;
  return segundos > 0 ? segundos : null;
}

// ─── custo ──────────────────────────────────────────────────────────────────

/**
 * Tokens de áudio de SAÍDA por segundo de fala — uma ESTIMATIVA, declarada.
 *
 * A tarifa oficial é por token (US$ 12/MTok de áudio de saída), mas o
 * `/v1/audio/speech` sem streaming não devolve `usage`. A própria OpenAI
 * publicava, na página de preços, a estimativa de "US$ 0,015 por minuto" para
 * o `gpt-4o-mini-tts` (a página atual já não traz o número; ele segue citado
 * pela equipe da OpenAI no fórum oficial). US$ 0,015 ÷ US$ 12/MTok = 1.250
 * tokens por minuto ≈ 20,8 por segundo. Com a duração real lida do Ogg, o erro
 * fica no fator tokens-por-segundo, e não no tamanho da fala.
 */
export const TOKENS_DE_AUDIO_POR_SEGUNDO = 1250 / 60;

/** Texto em português: ~4 caracteres por token, arredondado para cima. */
const CARACTERES_POR_TOKEN = 4;
/** Sem duração lida: ~15 caracteres falados por segundo. */
const CARACTERES_POR_SEGUNDO = 15;

export function custoDaSintese(e: { caracteres: number; duracaoSeg: number | null }): {
  inputTokens: number;
  outputTokens: number;
  costCents: number | null;
} {
  const inputTokens = Math.ceil(Math.max(0, e.caracteres) / CARACTERES_POR_TOKEN);
  const segundos = e.duracaoSeg ?? Math.max(1, e.caracteres / CARACTERES_POR_SEGUNDO);
  const outputTokens = Math.round(segundos * TOKENS_DE_AUDIO_POR_SEGUNDO);
  return {
    inputTokens,
    outputTokens,
    costCents: costCents(MODELO_DE_FALA, {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
  };
}
