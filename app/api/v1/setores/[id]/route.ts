/**
 * PATCH  /api/v1/setores/:id — renomeia e/ou substitui os membros (manager+),
 *        audit `setor.updated`.
 * DELETE /api/v1/setores/:id — exclui (manager+), audit `setor.deleted`. A FK
 *        `on delete set null (setor_id)` zera o setor das conversas e das
 *        intenções do roteador; nada mais some.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { atualizarSetorSchema } from "@/lib/setores/schemas";
import { substituirMembros } from "@/lib/setores/servico";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "setores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const body = await req.json().catch(() => null);
  const parsed = atualizarSetorSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  const { data: setor, error: lerErr } = await admin
    .from("setores")
    .select("id")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (lerErr) return fail("internal_error", t("Erro ao salvar o setor."), 500, { requestId });
  if (!setor) return fail("not_found", t("Setor não encontrado."), 404, { requestId });

  if (parsed.data.nome !== undefined) {
    const { error } = await admin
      .from("setores")
      .update({ nome: parsed.data.nome })
      .eq("organization_id", org.orgId)
      .eq("id", id);
    if (error?.code === "23505") {
      return fail("setor_nome_duplicado", t("Já existe um setor com este nome."), 409, { requestId });
    }
    if (error) return fail("internal_error", t("Erro ao salvar o setor."), 500, { requestId });
  }

  if (parsed.data.membros !== undefined) {
    try {
      await substituirMembros(admin, org.orgId, id, parsed.data.membros);
    } catch (err) {
      if ((err as { code?: string }).code === "23503") {
        return fail("validation_failed", t("Um dos membros não faz parte desta organização."), 422, { requestId });
      }
      return fail("internal_error", t("Erro ao salvar o setor."), 500, { requestId });
    }
  }

  void audit({
    action: "setor.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "setor",
    resourceId: id,
    requestId,
    metadata: {
      renomeado: parsed.data.nome !== undefined,
      ...(parsed.data.membros !== undefined ? { membros: parsed.data.membros.length } : {}),
    },
  });

  return ok({ id }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "setores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { data, error } = await createAdminClient()
    .from("setores")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao excluir o setor."), 500, { requestId });
  if (!data) return fail("not_found", t("Setor não encontrado."), 404, { requestId });

  void audit({
    action: "setor.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "setor",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
