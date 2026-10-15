/**
 * GET  /api/v1/setores — setores da organização, com os membros (qualquer
 *      membro lê: a inbox mostra e filtra pelo setor).
 * POST /api/v1/setores — cria setor (manager+), audit `setor.created`.
 *
 * Setor é para onde o Roteador de IA leva a conversa; o roteamento humano só
 * entrega a conversa a membros do setor (migration 0675, `lib/routing/setor.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarSetorSchema } from "@/lib/setores/schemas";
import { listarSetores, substituirMembros } from "@/lib/setores/servico";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "setores" });
  if (!authz.ok) return authz.response;
  try {
    const setores = await listarSetores(createAdminClient(), authz.org.orgId);
    return ok(setores, { requestId });
  } catch {
    return fail("internal_error", traduzir("Erro ao carregar os setores.", authz.user.idioma), 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "setores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const body = await req.json().catch(() => null);
  const parsed = criarSetorSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("setores")
    .insert({ organization_id: org.orgId, nome: parsed.data.nome })
    .select("id, nome, created_at")
    .single();
  if (error?.code === "23505") {
    return fail("setor_nome_duplicado", t("Já existe um setor com este nome."), 409, { requestId });
  }
  if (error || !data) {
    return fail("internal_error", t("Erro ao criar o setor."), 500, { requestId });
  }

  try {
    await substituirMembros(admin, org.orgId, data.id, parsed.data.membros);
  } catch (err) {
    // O setor foi criado; os membros não. Desfaz para não sobrar um setor
    // pela metade que o gestor não pediu.
    await admin.from("setores").delete().eq("organization_id", org.orgId).eq("id", data.id);
    if ((err as { code?: string }).code === "23503") {
      return fail("validation_failed", t("Um dos membros não faz parte desta organização."), 422, { requestId });
    }
    return fail("internal_error", t("Erro ao criar o setor."), 500, { requestId });
  }

  void audit({
    action: "setor.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "setor",
    resourceId: data.id,
    requestId,
    metadata: { membros: parsed.data.membros.length },
  });

  return ok({ ...data, membros: parsed.data.membros }, { requestId, status: 201 });
}
