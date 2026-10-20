/**
 * APROVAR um andamento — só o aprovado chega ao cliente.
 *
 * `manager`+, pela `fn_processos_andamento_aprovar` (migration 0707): ela trava a linha
 * (`for update`), grava quem aprovou e quando, e calcula o sha256 do texto que está NA LINHA —
 * nada disso vem de quem chama. O segundo clique encontra `aprovado` e é recusado.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { desfechoDaRpc } from "../../_desfecho";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "andamentos" });
  if (!authz.ok) return authz.response;
  const { id: andamentoId } = await ctx.params;

  const supabase = await createClient();
  return desfechoDaRpc(
    supabase.rpc("fn_processos_andamento_aprovar", { p_org: authz.org.orgId, p_id: andamentoId }),
    { requestId, andamentoId, action: "andamento.aprovado" },
  );
}
