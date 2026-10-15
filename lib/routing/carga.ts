/**
 * Carga atual e última atribuição de cada atendente, CONTADAS NO BANCO.
 *
 * Antes, o roteamento e o roster liam as linhas (`select assigned_to_user_id`
 * de toda conversa aberta; `conversation_assignment_events` inteiro) e contavam
 * em memória. O PostgREST corta a resposta em `max_rows` (1000 no
 * supabase/config.toml e no Supabase Cloud) SEM erro: com mais de 1000
 * conversas abertas ou 1000 eventos, a carga saía subcontada, o teto de
 * capacidade deixava passar quem estava cheio e o rodízio esquecia quem tinha
 * recebido por último. A função `fn_carga_e_rodizio_dos_atendentes` devolve uma
 * linha por atendente, qualquer que seja o volume.
 *
 * `organizationId` vem sempre do chamador (worker/admin/ctx do MCP), nunca do
 * corpo de requisição; a função só é executável por `service_role`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { OPEN_LOAD_STATUSES } from "./eligibility";

export interface CargaDoAtendente {
  /** Conversas abertas atribuídas (status em OPEN_LOAD_STATUSES). */
  carga: number;
  /** Epoch ms da última atribuição recebida (no canal, quando há escopo), ou null. */
  ultimaAtribuicaoEm: number | null;
}

type LinhaDaFuncao = { user_id: string; carga: number; ultima_atribuicao_em: string | null };

export async function carregarCargaERodizio(
  supabase: SupabaseClient,
  organizationId: string,
  userIds: string[],
  channelSessionId: string | null,
): Promise<Map<string, CargaDoAtendente>> {
  const porUsuario = new Map<string, CargaDoAtendente>();
  if (userIds.length === 0) return porUsuario;
  const { data, error } = await supabase.rpc("fn_carga_e_rodizio_dos_atendentes", {
    p_organization_id: organizationId,
    p_user_ids: userIds,
    p_statuses: [...OPEN_LOAD_STATUSES],
    p_channel_session_id: channelSessionId,
  });
  if (error) throw new Error(error.message);
  for (const linha of (data ?? []) as LinhaDaFuncao[]) {
    porUsuario.set(linha.user_id, {
      carga: Number(linha.carga) || 0,
      ultimaAtribuicaoEm: linha.ultima_atribuicao_em
        ? new Date(linha.ultima_atribuicao_em).getTime()
        : null,
    });
  }
  return porUsuario;
}
