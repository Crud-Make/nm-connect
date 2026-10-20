/**
 * crm_confirm_customer_identity — a conferência de CPF antes de abrir o banco
 * externo na conversa (a trava do CPF, issue #18).
 *
 * O desenho inteiro está em `lib/external-db/conferencia-de-cpf.ts`. Aqui, o
 * contrato com o modelo:
 *
 *   - entra SÓ `digitos` (os 3 últimos do CPF que o cliente digitou);
 *   - o telefone é o do contato do turno, lido do CRM pelo servidor;
 *   - sai SÓ `confere`, `tentativas_restantes`, `bloqueado` e uma instrução em
 *     texto. O CPF nunca passa por aqui; os dígitos não voltam ao modelo e não
 *     vão ao audit (`redigirParaAuditoria`).
 *
 * É ESCRITA (grava a tentativa em `verificacoes_de_identidade`, e o bloqueio
 * abre aviso na Central), mesmo lendo o banco externo — `tests/unit/tool-read-nao-muta.test.ts`.
 *
 * Duas peças daqui são de QUALQUER fonte da trava, e por isso são exportadas:
 * `concluirConferencia` (a cauda depois de saber se confere — gravar, bloquear,
 * avisar a Central, responder) e `recusaPelaTravaDoCpf` (a recusa da consulta
 * sem conferência válida). A fonte é a conexão do banco externo, ou `null` para o
 * CPF do cadastro do contato (migration 0706).
 */
import { z } from "zod";

import { abrirAcesso } from "@/lib/external-db/acesso";
import {
  aplicarResultado,
  avisarCentralDoBloqueio,
  conexoesQueExigemCpf,
  conferirCpfNoBancoExterno,
  gravarConferencia,
  lerConferencia,
  situacaoDaConferencia,
  telefoneDoContato,
  type EstadoDaConferencia,
} from "@/lib/external-db/conferencia-de-cpf";
import { logger } from "@/lib/logger";

import type { McpContext, McpToolDefinition } from "../types";

/** A ferramenta que lê o dado do banco externo depois da conferência. */
const CONSULTA_DO_BANCO_EXTERNO = "crm_query_external_data";

/** Onde a trava confere, e qual ferramenta o modelo usa depois de conferir. */
export interface AlvoDaConferencia {
  contatoId: string;
  /** A conexão do banco externo; `null` = o CPF do cadastro do contato (0706). */
  conexaoId: string | null;
  /** A ferramenta que lê o dado depois de a identidade conferir. */
  ferramentaDeConsulta: string;
}

function respostaConferiu(ferramentaDeConsulta: string) {
  return {
    confere: true,
    mensagem:
      `identidade confirmada. Agora consulte com ${ferramentaDeConsulta} e responda ao cliente. ` +
      "Não repita os dígitos na resposta.",
  };
}

const MENSAGEM_NAO_CONFERIU =
  "os dígitos não conferem. Peça com educação para o cliente conferir e mandar de novo os 3 " +
  "últimos dígitos do CPF. Não diga qual dígito está errado, não repita os dígitos que ele mandou " +
  "e não mostre nenhum dado do banco.";

const MENSAGEM_BLOQUEADO =
  "a conferência ficou bloqueada por excesso de tentativas. Não peça os dígitos de novo e não " +
  "informe nenhum dado do processo: diga ao cliente que a equipe do escritório vai atendê-lo " +
  "pessoalmente e passe a conversa para uma pessoa (request_human_handoff, ou " +
  "crm_request_human_handoff — a que você tiver).";

function respostaBloqueado() {
  return { confere: false, tentativas_restantes: 0, bloqueado: true, mensagem: MENSAGEM_BLOQUEADO };
}

const inputShape = {
  digitos: z
    .string()
    .regex(/^[0-9]{3}$/, "exatamente 3 números")
    .describe("Os 3 últimos dígitos do CPF, como o cliente escreveu — só os números."),
};

/** Os dígitos são parte do CPF: nunca vão ao `api_audit_log`. */
function redigirDigitos(args: Record<string, unknown>): Record<string, unknown> {
  return "digitos" in args ? { ...args, digitos: "[redigido]" } : args;
}

/** "Não conferiu" e "bloqueado" não são sucesso no audit (#484). Código fixo, sem dado. */
function motivoDaConferencia(resultado: unknown): string | null {
  if (resultado === null || typeof resultado !== "object") return null;
  const r = resultado as { erro?: unknown; confere?: unknown; bloqueado?: unknown };
  if (typeof r.erro === "string") return r.erro;
  if (r.bloqueado === true) return "bloqueado";
  return r.confere === false ? "nao_conferiu" : null;
}

export const crmConfirmCustomerIdentity: McpToolDefinition<typeof inputShape> = {
  name: "crm_confirm_customer_identity",
  description:
    "Confere a identidade do cliente desta conversa antes de mostrar dados de um banco conectado " +
    "que exige conferência de CPF. Use quando crm_query_external_data responder " +
    "`identidade_nao_conferida`: peça ao cliente os 3 últimos dígitos do CPF dele e passe aqui em " +
    "`digitos`. O telefone usado é o da própria conversa — você não informa. A resposta diz só se " +
    "conferiu e quantas tentativas restam. Nunca repita os dígitos na sua resposta, nunca diga " +
    "qual dígito está errado e nunca peça o CPF inteiro. Depois de 3 erros a conferência fica " +
    "bloqueada por 24 horas: diga que a equipe vai atender e passe a conversa para uma pessoa.",
  inputSchema: inputShape,
  category: "write",
  // `ai_operator`: só o agente no turno de uma conversa tem para quem conferir,
  // e nenhuma PESSOA alcança este papel — um token humano não vira máquina de
  // tentar dígitos (tests/unit/capacidade-alcancavel-pelo-agente.test.ts).
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redigirDigitos,
  motivoDoVazio: motivoDaConferencia,
  handler: async (input, ctx) => {
    const contatoId = ctx.contatoDoTurno;
    if (!contatoId) {
      return {
        erro: "fora_da_conversa",
        mensagem: "a conferência de CPF só existe dentro de uma conversa com o cliente.",
      };
    }

    let conexoes: Array<{ id: string; label: string }>;
    try {
      conexoes = await conexoesQueExigemCpf(ctx.supabase, ctx.organizationId);
    } catch {
      return { erro: "falha_na_conferencia", mensagem: "não foi possível conferir agora. Diga que a equipe confirma." };
    }
    if (conexoes.length === 0) {
      return {
        erro: "conferencia_nao_exigida",
        mensagem: "nenhum banco conectado exige conferência de CPF; consulte direto, sem pedir dígitos.",
      };
    }
    if (conexoes.length > 1) {
      // Uma conferência por conexão; com duas travadas, o modelo não tem como
      // dizer qual — e escolher por ele seria conferir na fonte errada.
      return {
        erro: "varias_conexoes_com_conferencia",
        mensagem: "há mais de um banco que exige conferência; diga ao cliente que a equipe vai confirmar.",
      };
    }
    const conexaoId = conexoes[0]!.id;
    const agora = new Date();

    let estado;
    try {
      estado = await lerConferencia(ctx.supabase, ctx.organizationId, contatoId, conexaoId);
    } catch {
      return { erro: "falha_na_conferencia", mensagem: "não foi possível conferir agora. Diga que a equipe confirma." };
    }

    // Bloqueado e já conferido NÃO perguntam ao banco externo: o primeiro é o
    // que impede a força bruta (1.000 combinações), o segundo poupa a ida.
    const situacao = situacaoDaConferencia(estado, agora);
    if (situacao.tipo === "bloqueado") return respostaBloqueado();
    if (situacao.tipo === "verificado") return respostaConferiu(CONSULTA_DO_BANCO_EXTERNO);

    const acesso = await abrirAcesso(ctx.supabase, ctx.organizationId, conexaoId);
    if (!acesso.ok) {
      return { erro: "falha_na_conferencia", mensagem: "não foi possível abrir o banco conectado agora. Diga que a equipe confirma." };
    }

    let telefone: string | null;
    try {
      telefone = await telefoneDoContato(ctx.supabase, ctx.organizationId, contatoId);
    } catch {
      return { erro: "falha_na_conferencia", mensagem: "não foi possível conferir agora. Diga que a equipe confirma." };
    }
    if (!telefone) {
      return {
        erro: "cliente_sem_telefone",
        mensagem: "o cliente desta conversa não tem telefone no cadastro, então não há como conferir. Diga que a equipe confirma.",
      };
    }

    let confere: boolean;
    try {
      confere = await conferirCpfNoBancoExterno(acesso.pool, telefone, input.digitos);
    } catch {
      // Falha do banco externo não é erro do cliente: não gasta tentativa.
      return { erro: "falha_na_conferencia", mensagem: "não foi possível conferir agora. Diga que a equipe confirma." };
    }

    return concluirConferencia(
      ctx,
      { contatoId, conexaoId, ferramentaDeConsulta: CONSULTA_DO_BANCO_EXTERNO },
      estado,
      confere,
      agora,
    );
  },
};

/**
 * A cauda de toda conferência, depois de a fonte dizer se os dígitos conferem:
 * aplica o resultado, grava a tentativa, abre o aviso na Central quando acabou
 * de bloquear e devolve a resposta ao modelo. Gravar falhou LANÇA — o bloqueio é
 * o que impede a força bruta, e uma tentativa que não ficou gravada não conta.
 */
export async function concluirConferencia(
  ctx: Pick<McpContext, "supabase" | "organizationId">,
  alvo: AlvoDaConferencia,
  estado: EstadoDaConferencia | null,
  confere: boolean,
  agora: Date,
): Promise<Record<string, unknown>> {
  const desfecho = aplicarResultado(estado, confere, agora);
  await gravarConferencia(ctx.supabase, ctx.organizationId, alvo.contatoId, alvo.conexaoId, desfecho.novo);

  if (desfecho.acabouDeBloquear) {
    try {
      await avisarCentralDoBloqueio(ctx.supabase, ctx.organizationId, alvo.contatoId);
    } catch (err) {
      // O bloqueio já está gravado — é ele que protege o dado. O aviso que
      // falhou vira log; o modelo segue instruído a passar para uma pessoa.
      logger.warn("[conferencia-de-cpf] aviso na Central falhou", {
        organizationId: ctx.organizationId,
        erro: err instanceof Error ? err.message.slice(0, 200) : "desconhecido",
      });
    }
    return respostaBloqueado();
  }

  if (confere) return respostaConferiu(alvo.ferramentaDeConsulta);
  return {
    confere: false,
    tentativas_restantes: desfecho.situacao.tipo === "pendente" ? desfecho.situacao.tentativasRestantes : 0,
    mensagem: MENSAGEM_NAO_CONFERIU,
  };
}

/**
 * A TRAVA DO CPF na consulta (issue #18). No turno de uma conversa, sem
 * conferência válida do contato naquela fonte, a consulta NÃO sai — volta um
 * erro em texto que ensina o modelo a pedir os dígitos e a usar
 * `ferramentaDeConfirmacao`, sem dado nenhum. Ler o estado falhou = recusa
 * (falha fechado). `null` = conferido, a consulta segue.
 */
export async function recusaPelaTravaDoCpf(
  ctx: Pick<McpContext, "supabase" | "organizationId">,
  contatoId: string,
  conexaoId: string | null,
  ferramentaDeConfirmacao: string,
): Promise<Record<string, unknown> | null> {
  let estado;
  try {
    estado = await lerConferencia(ctx.supabase, ctx.organizationId, contatoId, conexaoId);
  } catch {
    return {
      erro: "conferencia_indisponivel",
      mensagem:
        "não foi possível confirmar a identidade do cliente agora, então os dados não podem ser " +
        "mostrados. Diga que a equipe confirma.",
    };
  }
  const situacao = situacaoDaConferencia(estado, new Date());
  if (situacao.tipo === "verificado") return null;
  if (situacao.tipo === "bloqueado") {
    return {
      erro: "identidade_bloqueada",
      mensagem:
        "a conferência de identidade deste cliente está bloqueada por excesso de tentativas. Não " +
        "peça os dígitos de novo e não informe dado nenhum: diga que a equipe vai atendê-lo " +
        "pessoalmente e passe a conversa para uma pessoa.",
    };
  }
  return {
    erro: "identidade_nao_conferida",
    mensagem:
      "antes de mostrar dados deste banco é preciso confirmar a identidade do cliente. Peça a ele " +
      `os 3 últimos dígitos do CPF e chame ${ferramentaDeConfirmacao} com eles. Não consulte ` +
      "de novo antes de a conferência dar certo, e não repita os dígitos na resposta.",
  };
}
