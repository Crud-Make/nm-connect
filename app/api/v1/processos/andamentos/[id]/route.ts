/**
 * Editar o texto de um andamento.
 *
 * Sempre pela `fn_processos_andamento_editar` (migration 0707), nunca por UPDATE direto: é a
 * única porta que reescreve um APROVADO, e ela o devolve a rascunho na mesma escrita — quem
 * aprovou o texto antigo não aprovou o novo. Para um rascunho o desfecho é o mesmo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { andamentoTextoSchema } from "@/lib/schemas/processos";
import { createClient } from "@/lib/supabase/server";

import { corpoInvalido } from "../../_falha";
import { desfechoDaRpc } from "../_desfecho";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "andamentos" });
  if (!authz.ok) return authz.response;
  const { id: andamentoId } = await ctx.params;

  const lido = andamentoTextoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return corpoInvalido(lido.error.issues, requestId);

  const supabase = await createClient();
  return desfechoDaRpc(
    supabase.rpc("fn_processos_andamento_editar", {
      p_org: authz.org.orgId,
      p_id: andamentoId,
      p_texto: lido.data.texto,
    }),
    { requestId, andamentoId, action: "andamento.editado" },
  );
}
