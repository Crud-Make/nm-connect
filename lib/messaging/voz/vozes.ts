/**
 * As vozes da resposta em nota de voz — módulo PURO, sem dependência de
 * servidor, porque o schema da versão do agente (`lib/ai/agents/validation.ts`)
 * e a tela do agente também o importam.
 *
 * Fonte: as 13 vozes embutidas do `gpt-4o-mini-tts`, na ordem da referência
 * oficial de `POST /v1/audio/speech` (conferida em 20/10/2026). A doc recomenda
 * `marin` ou `cedar` para melhor qualidade — por isso `marin` é a padrão (e o
 * default da coluna `ai_agent_versions.voice_reply_voice`, migration 0704).
 */
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

/** Teto da instrução de tom guardada na versão do agente (o CHECK da 0704 repete). */
export const LIMITE_DA_INSTRUCAO_DE_TOM = 500;

export function vozValida(v: string | null | undefined): VozDeFala {
  return (VOZES_DE_FALA as readonly string[]).includes(v ?? "") ? (v as VozDeFala) : VOZ_PADRAO;
}
