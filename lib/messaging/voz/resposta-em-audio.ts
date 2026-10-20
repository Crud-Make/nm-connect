/**
 * RESPOSTA EM NOTA DE VOZ — a decisão e as duas etapas, sem I/O próprio.
 *
 * Quem liga: a versão publicada do agente (`ai_agent_versions.voice_reply_*`,
 * migration 0704), na tela do agente — "Responder áudio com áudio", DESLIGADO
 * por padrão. Quem dispara: a mensagem do cliente que abriu o turno ser uma
 * nota de voz (`messages.type = 'audio'`). Cliente que escreve recebe texto,
 * como sempre.
 *
 * A ORDEM é a regra que não se negocia, e é por isso que há duas etapas:
 *
 *  1. `prepararRespostaEmAudio` roda ANTES da cadeia `before_send`, fora do
 *     lock do número: resolve a chave OpenAI (a mesma escada da transcrição —
 *     credencial da organização, senão `OPENAI_API_KEY` da instalação) e
 *     pergunta ao teto de gasto se pode gastar. Sem chave ou com o teto mandando
 *     parar, a resposta já nasce texto, com o motivo.
 *  2. `gerarNotaDeVoz` só recebe o corpo que a cadeia APROVOU (o `finalBody`
 *     que o `send` do guardrail entrega), normaliza para fala e sintetiza.
 *     Qualquer falha devolve o motivo e quem chama manda o MESMO texto aprovado
 *     como texto. O áudio nunca diz nada que o texto aprovado não diga.
 *
 * A linha de custo (`chamada`) volta para quem chama gravar em `llm_calls`
 * DEPOIS da cadeia: dentro dela o turno segura o `pg_advisory_xact_lock` do
 * número e a trava de leitura de `contacts`, e um insert em `llm_calls` (FK
 * para `contacts`) por outra conexão é o ciclo que travou o worker na #2363.
 */
import { textoParaFala, type MotivoDeNaoFalar } from "./texto-para-fala";
import {
  custoDaSintese,
  MODELO_DE_FALA,
  vozValida,
  type MotivoDaFalhaDaSintese,
  type ResultadoDaSintese,
  type VozDeFala,
} from "./sintese-de-fala";

/** O ponto de IA (`lib/ai/pontos/registro.ts`) e o `purpose` gravado em `llm_calls`. */
export const PONTO_RESPOSTA_EM_AUDIO = "resposta_em_audio";

export type MotivoDoTexto =
  | "sem_chave_openai"
  | "orcamento_esgotado"
  | MotivoDeNaoFalar
  | MotivoDaFalhaDaSintese
  | "falha_ao_guardar"
  | "envio_do_audio_falhou"
  | "preparo_falhou";

/** Frase curta de cada motivo, para o log do turno e a metadata da mensagem. */
export const MOTIVOS_DO_TEXTO: Record<MotivoDoTexto, string> = {
  sem_chave_openai: "não há chave OpenAI nesta organização nem na instalação para gerar a voz",
  orcamento_esgotado: "o limite de gasto com IA do mês mandou parar",
  vazio: "a resposta não tinha nada que se fale",
  link_na_resposta: "a resposta tem um link, e o cliente precisa dele escrito",
  processo_sem_apelido: "a resposta cita um número de processo sem apelido conhecido",
  longo_demais: "a resposta passaria de um minuto de fala",
  prazo_esgotado: "a voz não ficou pronta dentro do prazo",
  rede: "a chamada à OpenAI falhou na rede",
  erro_da_api: "a OpenAI recusou o pedido de voz",
  formato_invalido: "a OpenAI devolveu um áudio que não é Ogg/Opus",
  falha_ao_guardar: "o áudio gerado não pôde ser guardado",
  envio_do_audio_falhou: "o canal recusou a nota de voz",
  preparo_falhou: "não consegui conferir a chave ou o limite de gasto da voz",
};

/** O que a versão publicada do agente declara. `null` = sem versão publicada. */
export interface ConfigDaVoz {
  enabled: boolean;
  voice: string | null;
  instructions: string | null;
}

export type DecisaoDoFormato =
  | { formato: "audio"; voz: VozDeFala; instrucoes: string | null }
  /** `motivo: null` = não era caso de áudio (cliente escreveu, interruptor desligado). */
  | { formato: "texto"; motivo: null };

/**
 * Pura. Só o turno que RESPONDE a uma mensagem nova (`inbound_turn`) fala: o
 * follow-up retoma conversa parada (ninguém mandou áudio agora), a resposta a
 * caso responde à ação de um humano, e a prévia não tem cliente do outro lado.
 */
export function decidirFormatoDaResposta(e: {
  config: ConfigDaVoz | null;
  tipoDaMensagemQueDisparou: string | null;
  jobKind: string | null;
  preview: boolean;
}): DecisaoDoFormato {
  if (
    e.preview ||
    e.config === null ||
    !e.config.enabled ||
    e.jobKind !== "inbound_turn" ||
    e.tipoDaMensagemQueDisparou !== "audio"
  ) {
    return { formato: "texto", motivo: null };
  }
  const instrucoes = e.config.instructions?.trim() || null;
  return { formato: "audio", voz: vozValida(e.config.voice), instrucoes };
}

export type OrigemDaChaveDeVoz = "credencial_da_organizacao" | "chave_da_instalacao";

export interface VozPronta {
  apiKey: string;
  origemDaChave: OrigemDaChaveDeVoz;
  voz: VozDeFala;
  instrucoes: string | null;
}

export type Preparo =
  { pronta: VozPronta; motivo: null } | { pronta: null; motivo: MotivoDoTexto | null };

/**
 * Etapa 1, fora do lock. `checarOrcamento` recebe a origem da chave porque o
 * teto do PLANO só vincula a chave da instalação (`aplicarOrcamento`).
 */
export async function prepararRespostaEmAudio(d: {
  decisao: DecisaoDoFormato;
  chaveOpenai: () => Promise<{ apiKey: string; origemDaChave: OrigemDaChaveDeVoz } | null>;
  checarOrcamento: (origem: OrigemDaChaveDeVoz) => Promise<"seguir" | "barrado">;
}): Promise<Preparo> {
  if (d.decisao.formato !== "audio") return { pronta: null, motivo: null };
  const chave = await d.chaveOpenai();
  if (!chave) return { pronta: null, motivo: "sem_chave_openai" };
  if ((await d.checarOrcamento(chave.origemDaChave)) === "barrado") {
    return { pronta: null, motivo: "orcamento_esgotado" };
  }
  return {
    pronta: { ...chave, voz: d.decisao.voz, instrucoes: d.decisao.instrucoes },
    motivo: null,
  };
}

/** A linha de `llm_calls` da síntese, sem a organização — quem grava completa. */
export interface ChamadaDeVoz {
  ok: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Centavos de dólar. 0 na chamada recusada (a OpenAI não cobra o que recusa). */
  costCents: number | null;
  latencyMs: number;
  status?: number;
  erro?: string;
}

export type NotaDeVoz =
  | {
      ok: true;
      storagePath: string;
      mime: "audio/ogg";
      duracaoSeg: number | null;
      chamada: ChamadaDeVoz;
    }
  | { ok: false; motivo: MotivoDoTexto; chamada: ChamadaDeVoz | null };

/**
 * Etapa 2, com o corpo APROVADO. `sintetizar` e `guardar` são injetados: o
 * turno passa `sintetizarFala` e o upload ao bucket `whatsapp-media`.
 */
export async function gerarNotaDeVoz(d: {
  texto: string;
  apelidos?: ReadonlyMap<string, string>;
  pronta: VozPronta;
  sintetizar: (e: {
    apiKey: string;
    texto: string;
    voz: VozDeFala;
    instrucoes: string | null;
  }) => Promise<ResultadoDaSintese>;
  guardar: (
    audio: Uint8Array,
    mime: "audio/ogg",
  ) => Promise<{ ok: true; storagePath: string } | { ok: false; detalhe: string }>;
}): Promise<NotaDeVoz> {
  const falavel = textoParaFala(d.texto, d.apelidos ? { apelidos: d.apelidos } : {});
  if (!falavel.ok) return { ok: false, motivo: falavel.motivo, chamada: null };

  const sintese = await d.sintetizar({
    apiKey: d.pronta.apiKey,
    texto: falavel.texto,
    voz: d.pronta.voz,
    instrucoes: d.pronta.instrucoes,
  });
  if (!sintese.ok) {
    return {
      ok: false,
      motivo: sintese.motivo,
      chamada: {
        ok: false,
        model: MODELO_DE_FALA,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: sintese.latenciaMs,
        ...(sintese.status !== undefined ? { status: sintese.status } : {}),
        erro: `${sintese.motivo}: ${sintese.detalhe}`,
      },
    };
  }
  const custo = custoDaSintese({
    caracteres: falavel.texto.length,
    duracaoSeg: sintese.duracaoSeg,
  });
  const chamada: ChamadaDeVoz = {
    ok: true,
    model: MODELO_DE_FALA,
    inputTokens: custo.inputTokens,
    outputTokens: custo.outputTokens,
    costCents: custo.costCents,
    latencyMs: sintese.latenciaMs,
  };
  const guardado = await d.guardar(sintese.audio, sintese.mime);
  // Gerado e não guardado: a OpenAI já cobrou, então o custo continua contado.
  if (!guardado.ok) return { ok: false, motivo: "falha_ao_guardar", chamada };
  return {
    ok: true,
    storagePath: guardado.storagePath,
    mime: sintese.mime,
    duracaoSeg: sintese.duracaoSeg,
    chamada,
  };
}

// ─── apelidos de processo colhidos no turno ─────────────────────────────────

const CNJ_EXATO = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;

/**
 * Varre o resultado de uma consulta ao banco externo (qualquer forma: objeto,
 * lista, ou JSON dentro do `text` da resposta MCP) atrás de pares
 * `numero_cnj` + `apelido` — as colunas da visão `ia.processos`
 * (`infra/nm-processos/001_base.sql`). Nunca lança.
 */
export function coletarApelidosDeProcesso(
  resultado: unknown,
  destino: Map<string, string>,
  profundidade = 0,
): void {
  if (profundidade > 8 || resultado === null || resultado === undefined) return;
  if (typeof resultado === "string") {
    const t = resultado.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.includes("numero_cnj")) {
      try {
        coletarApelidosDeProcesso(JSON.parse(t), destino, profundidade + 1);
      } catch {
        // texto que só parece JSON: nada a colher
      }
    }
    return;
  }
  if (Array.isArray(resultado)) {
    for (const item of resultado) coletarApelidosDeProcesso(item, destino, profundidade + 1);
    return;
  }
  if (typeof resultado !== "object") return;
  const obj = resultado as Record<string, unknown>;
  const cnj = obj.numero_cnj;
  const apelido = obj.apelido;
  if (
    typeof cnj === "string" &&
    CNJ_EXATO.test(cnj) &&
    typeof apelido === "string" &&
    apelido.trim() !== ""
  ) {
    destino.set(cnj, apelido.trim());
  }
  for (const valor of Object.values(obj)) {
    if (typeof valor === "object" || typeof valor === "string") {
      coletarApelidosDeProcesso(valor, destino, profundidade + 1);
    }
  }
}

/**
 * O sufixo do turno quando a resposta vai virar voz. Não muda o que o agente
 * pode dizer — só pede a forma que se fala bem, para a normalização ter pouco a
 * consertar e a resposta caber numa nota só.
 */
export function instrucaoDeVoz(decisao: DecisaoDoFormato): string {
  if (decisao.formato !== "audio") return "";
  return (
    "## Esta resposta vira nota de voz\n" +
    "O cliente mandou uma nota de voz, e a sua resposta vai ser FALADA para ele. Escreva como se fala: " +
    "frases curtas, sem listas, sem emoji e sem formatação, tudo numa única chamada de send_message. " +
    "Se a resposta precisar de um link, ela sai por escrito."
  );
}
