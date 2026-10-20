/**
 * ANDAMENTOS de um processo — o texto que vai PARA O CLIENTE.
 *
 * O que cada papel lê é da RLS de `andamentos` (migration 0707): `viewer` só o aprovado,
 * `agent`+ também os rascunhos. Lançar nasce sempre rascunho (a RLS não aceita outro status
 * da sessão); aprovar é `/api/v1/processos/andamentos/[id]/aprovar`, de manager+.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { andamentoTextoSchema } from "@/lib/schemas/processos";
import { createClient } from "@/lib/supabase/server";

import { corpoInvalido, respostaDaFalha } from "../../_falha";

export const dynamic = "force-dynamic";

// 23503: o processo não existe. 42501: existe, mas é de outra organização — a RLS recusa.
const PROCESSO_INVALIDO = "Processo inválido para esta organização.";

const COLUNAS = "id, processo_id, texto, status, aprovado_em, created_at";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "andamentos" });
  if (!authz.ok) return authz.response;
  const { id: processoId } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("andamentos")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("processo_id", processoId)
    .order("created_at", { ascending: false });
  if (error) return respostaDaFalha(error, requestId, PROCESSO_INVALIDO);
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "andamentos" });
  if (!authz.ok) return authz.response;
  const { id: processoId } = await ctx.params;

  const lido = andamentoTextoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return corpoInvalido(lido.error.issues, requestId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("andamentos")
    .insert({
      organization_id: authz.org.orgId,
      processo_id: processoId,
      texto: lido.data.texto,
      criado_por: authz.user.id,
    })
    .select(COLUNAS)
    .single();
  if (error) return respostaDaFalha(error, requestId, PROCESSO_INVALIDO);

  await audit({
    action: "andamento.criado",
    resourceType: "andamento",
    resourceId: data.id,
    requestId,
    metadata: { processo_id: processoId },
  });

  return ok(data, { requestId });
}
