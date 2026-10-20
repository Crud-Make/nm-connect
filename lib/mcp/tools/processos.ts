/**
 * Capacidades de PROCESSOS — módulo opcional de advocacia (ADR-0002) na conversa.
 *
 * O cliente pergunta "como está o meu processo?" no WhatsApp e o assistente
 * responde com o que a equipe ESCREVEU e APROVOU para ele — nunca com rascunho,
 * nunca com o processo de outra pessoa. Três travas, nesta ordem:
 *
 *   1. Só no turno de uma conversa (`ctx.contatoDoTurno`), e só os processos
 *      DESSE contato: sem conversa, a leitura recusa — rota HTTP e MCP externo
 *      leem processo pela tela, não por aqui.
 *   2. A trava do CPF (#18) contra o CPF do CADASTRO do contato (migration 0706,
 *      conexão `null`): o telefone sozinho não prova quem fala.
 *   3. Só `status = 'aprovado'`: o texto passou por uma pessoa (manager+) e o
 *      banco amarra o aprovado ao hash do texto (0707).
 *
 * O número CNJ NÃO sai daqui. É público, mas leva à pessoa por consulta em
 * qualquer tribunal, e o cliente conhece o processo pelo apelido ("o divórcio").
 *
 * A confirmação é a mesma máquina de `./conferencia-de-identidade.ts` — só a
 * fonte muda: `conferirCpfDoContato` no lugar do banco externo.
 *
 * Service role bypassa RLS: TODA query filtra `organization_id` manualmente.
 */
import { conferirCpfDoContato, lerConferencia } from "@/lib/external-db/conferencia-de-cpf";

import type { McpToolDefinition } from "../types";

import {
  concluirConferencia,
  digitosShape,
  falhaNaConferencia,
  foraDaConversa,
  motivoDaConferencia,
  recusaPelaTravaDoCpf,
  redigirDigitos,
  respostaSemPerguntarAFonte,
} from "./conferencia-de-identidade";

const CONSULTA_DE_PROCESSOS = "crm_list_processos_do_cliente";
const CONFIRMACAO_DE_PROCESSOS = "crm_confirm_processos_identity";

/** Os andamentos mais recentes que vão ao modelo — o resto é histórico da tela. */
const MAX_ANDAMENTOS = 20;

const MODULO_NAO_INSTALADO_HINT =
  "módulo de processos não está instalado nesta instalação (peça ao administrador para " +
  "instalar em Configurações da instalação › Módulos) — esta capacidade não deveria estar " +
  "ligada em nenhum agente enquanto isso";

function falhaDaLeitura(error: { code?: string; message: string }): Error {
  const tabelaInexistente = error.code === "42P01" || error.code === "PGRST205";
  return new Error(`processos_falhou: ${tabelaInexistente ? MODULO_NAO_INSTALADO_HINT : error.message}`);
}

// ---------------------------------------------------------------------------
// a consulta
// ---------------------------------------------------------------------------

/** Sem entrada: o cliente é o do turno, lido do contexto — não há campo que aponte para outro. */
const processosShape = {};

export const crmListProcessosDoCliente: McpToolDefinition<typeof processosShape> = {
  name: "crm_list_processos_do_cliente",
  description:
    "Traz os processos do cliente desta conversa — apelido, área e fase — com os andamentos " +
    "que a equipe do escritório escreveu e aprovou para ele, do mais recente ao mais antigo. " +
    "Use quando o cliente perguntar como está o processo dele. Antes, a identidade precisa " +
    `estar conferida: se responder \`identidade_nao_conferida\`, peça os 3 últimos dígitos do CPF ` +
    `e chame ${CONFIRMACAO_DE_PROCESSOS}. Conte ao cliente só o que está no texto do andamento, ` +
    "com suas palavras e sem prometer prazo ou resultado. Sem andamento, diga que a equipe vai " +
    "atualizá-lo. Só funciona dentro da conversa, e só traz os processos de quem está falando.",
  inputSchema: processosShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const contatoId = ctx.contatoDoTurno;
    if (!contatoId) {
      return {
        erro: "fora_da_conversa",
        mensagem: "os processos só são lidos dentro de uma conversa com o cliente, e só os dele.",
      };
    }

    const recusa = await recusaPelaTravaDoCpf(ctx, contatoId, null, CONFIRMACAO_DE_PROCESSOS);
    if (recusa) return recusa;

    const { data: processos, error } = await ctx.supabase
      .from("processos")
      .select("id, apelido, area, fase")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contatoId)
      .order("created_at", { ascending: true });
    if (error) throw falhaDaLeitura(error);
    if (!processos?.length) return { processos: [] };

    const { data: andamentos, error: erroAndamentos } = await ctx.supabase
      .from("andamentos")
      .select("processo_id, texto, aprovado_em")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "aprovado")
      .in("processo_id", processos.map((p) => p.id))
      .order("aprovado_em", { ascending: false })
      .limit(MAX_ANDAMENTOS);
    if (erroAndamentos) throw falhaDaLeitura(erroAndamentos);

    // Montada campo a campo: o id do processo amarra o andamento e não sai.
    return {
      processos: processos.map((p) => ({
        apelido: p.apelido,
        area: p.area,
        fase: p.fase,
        andamentos: (andamentos ?? [])
          .filter((a) => a.processo_id === p.id)
          .map((a) => ({ texto: a.texto, aprovado_em: a.aprovado_em })),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// a confirmação de identidade pelo CPF do cadastro
// ---------------------------------------------------------------------------

export const crmConfirmProcessosIdentity: McpToolDefinition<typeof digitosShape> = {
  name: "crm_confirm_processos_identity",
  description:
    "Confere a identidade do cliente desta conversa antes de mostrar os processos dele. Use " +
    `quando ${CONSULTA_DE_PROCESSOS} responder \`identidade_nao_conferida\`: peça ao cliente os ` +
    "3 últimos dígitos do CPF dele e passe aqui em `digitos`. A conferência é contra o CPF do " +
    "cadastro dele — você não informa quem é. A resposta diz só se conferiu e quantas tentativas " +
    "restam. Nunca repita os dígitos na sua resposta, nunca diga qual dígito está errado e nunca " +
    "peça o CPF inteiro. Depois de 3 erros a conferência fica bloqueada por 24 horas: diga que a " +
    "equipe vai atender e passe a conversa para uma pessoa.",
  inputSchema: digitosShape,
  category: "write",
  // `ai_operator`, como `crm_confirm_customer_identity`: um token humano não
  // vira máquina de tentar dígitos (tests/unit/capacidade-alcancavel-pelo-agente.test.ts).
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redigirDigitos,
  motivoDoVazio: motivoDaConferencia,
  handler: async (input, ctx) => {
    const contatoId = ctx.contatoDoTurno;
    if (!contatoId) return foraDaConversa();
    const agora = new Date();

    let estado;
    try {
      estado = await lerConferencia(ctx.supabase, ctx.organizationId, contatoId, null);
    } catch {
      return falhaNaConferencia();
    }
    const pronta = respostaSemPerguntarAFonte(estado, agora, CONSULTA_DE_PROCESSOS);
    if (pronta) return pronta;

    let confere: boolean | null;
    try {
      confere = await conferirCpfDoContato(ctx.supabase, ctx.organizationId, contatoId, input.digitos);
    } catch {
      return falhaNaConferencia();
    }
    // Sem CPF no cadastro não há contra o que conferir — e a culpa não é do
    // cliente: não gasta tentativa, e uma pessoa da equipe assume.
    if (confere === null) {
      return {
        erro: "cliente_sem_cpf",
        mensagem:
          "o cliente desta conversa não tem CPF no cadastro, então não há como conferir a " +
          "identidade. Não informe nada do processo: diga que a equipe do escritório vai atendê-lo " +
          "e passe a conversa para uma pessoa (request_human_handoff, ou crm_request_human_handoff " +
          "— a que você tiver).",
      };
    }

    return concluirConferencia(
      ctx,
      { contatoId, conexaoId: null, ferramentaDeConsulta: CONSULTA_DE_PROCESSOS },
      estado,
      confere,
      agora,
    );
  },
};
