/**
 * Leitura e escrita de setores pelo service role (migration 0675).
 *
 * Todo acesso filtra `organization_id` à mão: o client admin passa por cima da
 * RLS, e a organização vem SEMPRE de `requireRole` na rota, nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SetorComMembros {
  id: string;
  nome: string;
  created_at: string;
  /** user_ids dos membros. */
  membros: string[];
}

export async function listarSetores(admin: SupabaseClient, orgId: string): Promise<SetorComMembros[]> {
  const [setores, membros] = await Promise.all([
    admin
      .from("setores")
      .select("id, nome, created_at")
      .eq("organization_id", orgId)
      .order("nome", { ascending: true }),
    admin.from("setor_membros").select("setor_id, user_id").eq("organization_id", orgId),
  ]);
  if (setores.error) throw setores.error;
  if (membros.error) throw membros.error;
  const porSetor = new Map<string, string[]>();
  for (const m of (membros.data ?? []) as Array<{ setor_id: string; user_id: string }>) {
    porSetor.set(m.setor_id, [...(porSetor.get(m.setor_id) ?? []), m.user_id]);
  }
  return ((setores.data ?? []) as Array<{ id: string; nome: string; created_at: string }>).map((s) => ({
    ...s,
    membros: porSetor.get(s.id) ?? [],
  }));
}

/**
 * Substitui a lista inteira de membros do setor.
 *
 * Sem transação (HTTP): apaga e insere. Uma falha no insert (ex.: user_id que
 * não é da organização — a FK composta com `user_organizations` recusa com
 * 23503) devolve o conjunto anterior antes de propagar o erro, para a tela não
 * ficar com o setor esvaziado por um clique recusado.
 */
export async function substituirMembros(
  admin: SupabaseClient,
  orgId: string,
  setorId: string,
  membros: readonly string[],
): Promise<void> {
  const anteriores = await admin
    .from("setor_membros")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("setor_id", setorId);
  if (anteriores.error) throw anteriores.error;
  const apagou = await admin.from("setor_membros").delete().eq("organization_id", orgId).eq("setor_id", setorId);
  if (apagou.error) throw apagou.error;
  if (membros.length === 0) return;
  const linhas = (ids: readonly string[]) =>
    ids.map((user_id) => ({ organization_id: orgId, setor_id: setorId, user_id }));
  const inseriu = await admin.from("setor_membros").insert(linhas(membros));
  if (!inseriu.error) return;
  const antes = ((anteriores.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  if (antes.length > 0) {
    await admin.from("setor_membros").upsert(linhas(antes), { onConflict: "setor_id,user_id", ignoreDuplicates: true });
  }
  throw inseriu.error;
}
