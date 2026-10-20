/**
 * PROCESSOS — o processo judicial de cada cliente (módulo opcional `processos`, ADR-0002).
 *
 * As tabelas só existem depois que o administrador da instalação instala o módulo em
 * `/admin/modulos` (migration 0707). Antes disso a falha vira 409 `module_not_installed`.
 *
 * ⚠️ CLIENT DE SESSÃO. A RLS de `processos` já exige `agent`+ para escrever; a rota cobra o
 * mesmo degrau por clareza de mensagem. O contato é conferido pela FK COMPOSTA
 * `(organization_id, contact_id)`: com a organização da sessão no insert, o contato de outra
 * organização é recusado pelo banco (23503), sem uma leitura a mais aqui.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { listarProcessosQuerySchema, processoCreateSchema } from "@/lib/schemas/processos";
import { createClient } from "@/lib/supabase/server";

import { corpoInvalido, respostaDaFalha } from "./_falha";

export const dynamic = "force-dynamic";

const CONTATO_INVALIDO = "Contato inválido para esta organização.";

const COLUNAS =
  "id, contact_id, numero_cnj, apelido, area, fase, created_at, contacts!processos_contato_fkey(name, display_name, phone_number)";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "processos" });
  if (!authz.ok) return authz.response;

  const query = listarProcessosQuerySchema.safeParse({
    contact_id: req.nextUrl.searchParams.get("contact_id") ?? undefined,
  });
  if (!query.success) return corpoInvalido(query.error.issues, requestId);

  const supabase = await createClient();
  let q = supabase
    .from("processos")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (query.data.contact_id) q = q.eq("contact_id", query.data.contact_id);

  const { data, error } = await q;
  if (error) return respostaDaFalha(error, requestId, CONTATO_INVALIDO);
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "processos" });
  if (!authz.ok) return authz.response;

  const lido = processoCreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return corpoInvalido(lido.error.issues, requestId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("processos")
    .insert({ organization_id: authz.org.orgId, ...lido.data })
    .select(COLUNAS)
    .single();
  if (error) return respostaDaFalha(error, requestId, CONTATO_INVALIDO);

  await audit({
    action: "processo.criado",
    resourceType: "processo",
    resourceId: data.id,
    requestId,
    metadata: { contact_id: data.contact_id },
  });

  return ok(data, { requestId });
}
