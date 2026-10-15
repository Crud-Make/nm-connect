/**
 * A TRAVA DO CPF — conferir quem fala antes de abrir o banco externo (issue #18).
 *
 * Numa conexão com `require_cpf_check`, a consulta do agente na conversa só sai
 * depois de o contato do turno acertar os 3 últimos dígitos do CPF. O telefone
 * do WhatsApp sozinho não prova identidade: um número reaproveitado, um celular
 * emprestado ou um parente no aparelho leriam o processo de outra pessoa.
 *
 * ─── O que o modelo vê, e o que nunca vê ────────────────────────────────────
 *
 * A conferência é do BANCO EXTERNO: `ia.conferir_cpf(telefone, digitos)` devolve
 * só `boolean`, e o CPF nunca sai de lá — nem para este servidor. O modelo manda
 * os dígitos que o cliente digitou e recebe de volta `confere` e quantas
 * tentativas restam. O telefone é o do CONTATO DO TURNO, lido do CRM pelo
 * servidor; o modelo não escreve nem vê esse valor.
 *
 * ─── Por que o nome da função é FIXO ────────────────────────────────────────
 *
 * Configurável, ele seria um identificador escrito na tela e interpolado no SQL
 * — a única porta deste conector por onde texto do cadastro viraria código. O
 * contrato do banco de processos (`infra/nm-processos/001_base.sql`) já fixa a
 * assinatura `ia.conferir_cpf(text, text) returns boolean`, e o papel
 * `crm_leitor` só tem EXECUTE nela. Outro banco que queira a trava implementa a
 * mesma assinatura.
 *
 * ─── O estado mora no CRM ───────────────────────────────────────────────────
 *
 * `public.verificacoes_de_identidade`, uma linha por (organização, contato,
 * conexão). O banco externo é só leitura (`BEGIN READ ONLY` em `consultar`), e
 * a função é `stable` — a conferência cabe na mesma transação somente-leitura.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { consultar } from "./conexao";

/** A função de conferência no banco externo. Fixa de propósito (cabeçalho). */
export const FUNCAO_DE_CONFERENCIA = "ia.conferir_cpf";

const SQL_DA_CONFERENCIA = `select ${FUNCAO_DE_CONFERENCIA}($1::text, $2::text) as confere`;

const HORA_MS = 60 * 60 * 1000;

/** Por quanto tempo uma conferência certa libera a consulta daquele contato. */
export const VALIDADE_DA_CONFERENCIA_MS = 24 * HORA_MS;

/** Erros seguidos que bloqueiam a conferência (e abrem o aviso na Central). */
export const MAX_TENTATIVAS = 3;

/** Por quanto tempo o bloqueio dura. Depois dele, a contagem recomeça do zero. */
export const BLOQUEIO_APOS_ERROS_MS = 24 * HORA_MS;

export interface EstadoDaConferencia {
  verificadoAte: Date | null;
  tentativasFalhas: number;
  bloqueadoAte: Date | null;
}

export type SituacaoDaConferencia =
  | { tipo: "verificado" }
  | { tipo: "bloqueado"; ate: Date }
  | { tipo: "pendente"; tentativasRestantes: number };

const NADA: EstadoDaConferencia = { verificadoAte: null, tentativasFalhas: 0, bloqueadoAte: null };

/** Bloqueio vencido zera a contagem: quem errou ontem tem as 3 tentativas hoje. */
function semBloqueioVencido(estado: EstadoDaConferencia | null, agora: Date): EstadoDaConferencia {
  if (!estado) return NADA;
  if (estado.bloqueadoAte && estado.bloqueadoAte <= agora) {
    return { ...estado, tentativasFalhas: 0, bloqueadoAte: null };
  }
  return estado;
}

/** Onde o contato está agora. Bloqueio vence verificação: a dúvida fecha. */
export function situacaoDaConferencia(
  estado: EstadoDaConferencia | null,
  agora: Date,
): SituacaoDaConferencia {
  const e = semBloqueioVencido(estado, agora);
  if (e.bloqueadoAte && e.bloqueadoAte > agora) return { tipo: "bloqueado", ate: e.bloqueadoAte };
  if (e.verificadoAte && e.verificadoAte > agora) return { tipo: "verificado" };
  return { tipo: "pendente", tentativasRestantes: Math.max(0, MAX_TENTATIVAS - e.tentativasFalhas) };
}

/** O estado depois de uma conferência feita no banco externo. Puro. */
export function aplicarResultado(
  estado: EstadoDaConferencia | null,
  confere: boolean,
  agora: Date,
): { novo: EstadoDaConferencia; situacao: SituacaoDaConferencia; acabouDeBloquear: boolean } {
  const base = semBloqueioVencido(estado, agora);
  let novo: EstadoDaConferencia;
  let acabouDeBloquear = false;
  if (confere) {
    novo = {
      verificadoAte: new Date(agora.getTime() + VALIDADE_DA_CONFERENCIA_MS),
      tentativasFalhas: 0,
      bloqueadoAte: null,
    };
  } else {
    const tentativasFalhas = base.tentativasFalhas + 1;
    acabouDeBloquear = tentativasFalhas >= MAX_TENTATIVAS;
    novo = {
      verificadoAte: null,
      tentativasFalhas,
      bloqueadoAte: acabouDeBloquear ? new Date(agora.getTime() + BLOQUEIO_APOS_ERROS_MS) : null,
    };
  }
  return { novo, situacao: situacaoDaConferencia(novo, agora), acabouDeBloquear };
}

/** E.164 com `+`, só dígitos — a forma que `escritorio.telefone_canonico` espera. */
export function telefoneParaConferencia(telefone: string | null | undefined): string | null {
  const digitos = telefone?.replace(/\D/g, "") ?? "";
  return digitos ? `+${digitos}` : null;
}

/**
 * Pergunta ao banco externo se os dígitos conferem. Telefone e dígitos vão como
 * parâmetro (`$1`, `$2`), nunca no texto. Só `true` literal confere.
 */
export async function conferirCpfNoBancoExterno(
  pool: pg.Pool,
  telefone: string,
  digitos: string,
): Promise<boolean> {
  const r = await consultar<{ confere: boolean | null }>(pool, SQL_DA_CONFERENCIA, [telefone, digitos]);
  return r.rows[0]?.confere === true;
}

// ---------------------------------------------------------------------------
// Leitura e escrita no CRM (service role — `organization_id` em TODA query)
// ---------------------------------------------------------------------------

interface LinhaDaConferencia {
  verificado_ate: string | null;
  tentativas_falhas: number | null;
  bloqueado_ate: string | null;
}

const data = (v: string | null): Date | null => (v ? new Date(v) : null);

/** O estado guardado. `null` = nunca conferiu. Erro de leitura LANÇA: quem chama falha fechado. */
export async function lerConferencia(
  supabase: SupabaseClient,
  organizationId: string,
  contatoId: string,
  conexaoId: string,
): Promise<EstadoDaConferencia | null> {
  const { data: linha, error } = await supabase
    .from("verificacoes_de_identidade")
    .select("verificado_ate, tentativas_falhas, bloqueado_ate")
    .eq("organization_id", organizationId)
    .eq("contact_id", contatoId)
    .eq("connection_id", conexaoId)
    .maybeSingle<LinhaDaConferencia>();
  if (error) throw new Error(`ler_conferencia_falhou: ${error.message}`);
  if (!linha) return null;
  return {
    verificadoAte: data(linha.verificado_ate),
    tentativasFalhas: linha.tentativas_falhas ?? 0,
    bloqueadoAte: data(linha.bloqueado_ate),
  };
}

export async function gravarConferencia(
  supabase: SupabaseClient,
  organizationId: string,
  contatoId: string,
  conexaoId: string,
  estado: EstadoDaConferencia,
): Promise<void> {
  const { error } = await supabase.from("verificacoes_de_identidade").upsert(
    {
      organization_id: organizationId,
      contact_id: contatoId,
      connection_id: conexaoId,
      verificado_ate: estado.verificadoAte?.toISOString() ?? null,
      tentativas_falhas: estado.tentativasFalhas,
      bloqueado_ate: estado.bloqueadoAte?.toISOString() ?? null,
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: "organization_id,contact_id,connection_id" },
  );
  if (error) throw new Error(`gravar_conferencia_falhou: ${error.message}`);
}

/** As conexões ATIVAS desta organização que exigem a conferência. */
export async function conexoesQueExigemCpf(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Array<{ id: string; label: string }>> {
  const { data: linhas, error } = await supabase
    .from("external_db_connections_safe")
    .select("id, label")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .eq("require_cpf_check", true)
    .order("label", { ascending: true });
  if (error) throw new Error(`listar_conexoes_falhou: ${error.message}`);
  return (linhas ?? []) as Array<{ id: string; label: string }>;
}

/** O telefone do contato do turno, do cadastro do CRM, em E.164. */
export async function telefoneDoContato(
  supabase: SupabaseClient,
  organizationId: string,
  contatoId: string,
): Promise<string | null> {
  const { data: contato, error } = await supabase
    .from("contacts")
    .select("phone_number")
    .eq("organization_id", organizationId)
    .eq("id", contatoId)
    .maybeSingle<{ phone_number: string | null }>();
  if (error) throw new Error(`ler_contato_falhou: ${error.message}`);
  return telefoneParaConferencia(contato?.phone_number);
}

const TITULO_DO_AVISO = "Cliente errou a conferência de CPF 3 vezes — assumir a conversa";
const CORPO_DO_AVISO =
  "O assistente bloqueou por 24 horas a consulta aos dados deste cliente depois de 3 tentativas " +
  "erradas dos últimos dígitos do CPF. Confirme a identidade da pessoa antes de passar qualquer " +
  "informação.";

/**
 * O aviso na Central quando a conferência bloqueia — o mesmo `kind='handoff'`
 * por conversa que a passagem do motor abre, então a `request_human_handoff`
 * que o modelo chama em seguida ENRIQUECE este aviso em vez de abrir outro, e
 * quem assume a conversa o resolve pelo caminho de sempre
 * (`fn_passagem_reconhecida`). Se o modelo não chamar a passagem, o aviso
 * sozinho já põe a conversa diante de uma pessoa. Sem PII no corpo.
 *
 * Já existe aviso de passagem aberto nessa conversa: não abre outro.
 */
export async function avisarCentralDoBloqueio(
  supabase: SupabaseClient,
  organizationId: string,
  contatoId: string,
): Promise<void> {
  const { data: conversa, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contatoId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`ler_conversa_falhou: ${error.message}`);
  if (!conversa) return;

  const { data: aberto, error: erroAberto } = await supabase
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", "handoff")
    .eq("ref_kind", "conversation")
    .eq("ref_id", conversa.id)
    .eq("status", "open")
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (erroAberto) throw new Error(`ler_aviso_falhou: ${erroAberto.message}`);
  if (aberto) return;

  const { error: erroInsert } = await supabase.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: "handoff",
    severity: "critical",
    title: TITULO_DO_AVISO,
    body: CORPO_DO_AVISO,
    ref_kind: "conversation",
    ref_id: conversa.id,
  });
  if (erroInsert) throw new Error(`abrir_aviso_falhou: ${erroInsert.message}`);
}
