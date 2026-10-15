/**
 * Carregador reutilizável de atendentes elegíveis (G5-02/G5-03 → G6-01/INB-12).
 *
 * A lógica de "quem pode receber uma conversa agora" (disponível ∧ dentro do
 * horário ∧ com folga) vivia inline no worker de roteamento. G6-01 unifica: o
 * mesmo cálculo alimenta o worker (cron), o handoff v2 (crm_request_human_handoff)
 * e o crm_get_queue_status — UM algoritmo, não três divergentes.
 *
 * O client é injetado (worker passa admin; tools MCP passam ctx.supabase admin),
 * mantendo a org-scoping explícita em toda query (service role bypassa RLS).
 */
import type { Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

import { carregarCargaERodizio } from "./carga";
import { isAttendantEligible } from "./eligibility";
import { restringirAoSetor } from "./setor";
import type { RoutingCandidate } from "./decide";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

export type RoutingScope =
  | {
      kind: "conversation_channel";
      channelSessionId: string;
      /**
       * Setor da conversa (`conversations.setor_id`). Presente e com membros ⇒
       * só membros do setor recebem; ninguém elegível ⇒ [] e a conversa fica na
       * fila (regra em `./setor.ts`). Ausente/null ⇒ comportamento de antes.
       */
      setorId?: string | null;
    }
  | { kind: "organization_summary" };
export class InvalidRoutingChannel extends Error {
  constructor() { super("routing_channel_invalid"); }
}

/** Elegíveis = disponíveis ∧ dentro do horário ∧ com folga (carga < capacidade). */
export async function loadEligibleAttendants(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date,
  scope: RoutingScope,
): Promise<RoutingCandidate[]> {
  let allowed: Set<string> | null = null;
  if (scope.kind === "conversation_channel") {
    const { data: channel, error: channelError } = await supabase.from("channel_sessions")
      .select("id").eq("organization_id", organizationId).eq("id", scope.channelSessionId).maybeSingle();
    if (channelError) throw new Error(channelError.message);
    if (!channel) throw new InvalidRoutingChannel();
    const { data: policy, error: policyError } = await supabase.from("channel_routing_policies")
      .select("id").eq("organization_id", organizationId).eq("channel_session_id", scope.channelSessionId).maybeSingle();
    if (policyError) throw new Error(policyError.message);
    if (policy) {
      const { data: responsibles, error } = await supabase.from("channel_routing_responsibles")
        .select("user_id").eq("organization_id", organizationId).eq("policy_id", policy.id);
      if (error) throw new Error(error.message);
      allowed = new Set((responsibles ?? []).map((r: { user_id: string }) => r.user_id));
      // Policy existente vazia é restrição explícita, não ausência de configuração.
      if (allowed.size === 0) return [];
    }
    if (scope.setorId) {
      const { data: membros, error: setorError } = await supabase.from("setor_membros")
        .select("user_id").eq("organization_id", organizationId).eq("setor_id", scope.setorId);
      if (setorError) throw new Error(setorError.message);
      allowed = restringirAoSetor(allowed, (membros ?? []).map((r: { user_id: string }) => r.user_id));
      // Setor com membros e nenhum deles permitido pelo canal: fila, não outro setor.
      if (allowed !== null && allowed.size === 0) return [];
    }
  }
  const { data: members, error: memberError } = await supabase.from("user_organizations")
    .select("user_id").eq("organization_id", organizationId).is("revoked_at", null)
    .in("role", ["agent", "manager", "admin"]);
  if (memberError) throw new Error(memberError.message);
  const active = new Set((members ?? []).map((r: { user_id: string }) => r.user_id));
  const { data: avail, error: availabilityError } = await supabase
    .from("attendant_availability").select("user_id, capacity, schedule")
    .eq("organization_id", organizationId).eq("is_available", true);
  if (availabilityError) throw new Error(availabilityError.message);
  const rows = ((avail ?? []) as Array<{ user_id: string; capacity: number; schedule: unknown }>)
    .filter((r) => active.has(r.user_id) && (allowed === null || allowed.has(r.user_id)));
  if (rows.length === 0) return [];

  const userIds = rows.map((r) => r.user_id);

  // Carga atual e última atribuição recebida (rodízio real, sem coluna de
  // estado), contadas no banco: ler as linhas esbarrava no corte de 1000 do
  // PostgREST e subcontava em silêncio (lib/routing/carga.ts).
  const cargas = await carregarCargaERodizio(
    supabase,
    organizationId,
    userIds,
    scope.kind === "conversation_channel" ? scope.channelSessionId : null,
  );

  const candidates: RoutingCandidate[] = [];
  for (const r of rows) {
    const currentLoad = cargas.get(r.user_id)?.carga ?? 0;
    const schedule = availabilityScheduleSchema.parse(r.schedule ?? {});
    const eligible = isAttendantEligible(
      { isAvailable: true, capacity: r.capacity, currentLoad, schedule },
      now,
    );
    if (eligible) {
      candidates.push({
        userId: r.user_id,
        currentLoad,
        scheduleSnapshot: r.schedule as Json,
        lastAssignedAt: cargas.get(r.user_id)?.ultimaAtribuicaoEm ?? null,
      });
    }
  }
  return candidates;
}
