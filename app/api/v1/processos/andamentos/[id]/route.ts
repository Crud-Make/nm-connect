/**
 * Editar o texto de um andamento.
 *
 * Sempre pela `fn_processos_andamento_editar` (migration 0707), nunca por UPDATE direto: é a
 * única porta que reescreve um APROVADO, e ela o devolve a rascunho na mesma escrita — quem
 * aprovou o texto antigo não aprovou o novo. Para um rascunho o desfecho é o mesmo.
 */
import type { NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { abrirEscritaDeAndamento } from "../../_falha";
import { desfechoDaRpc } from "../_desfecho";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const escrita = await abrirEscritaDeAndamento(req, ctx);
  if (!escrita.ok) return escrita.resposta;
  const { id: andamentoId, texto } = escrita.dados;

  const supabase = await createClient();
  return desfechoDaRpc(
    supabase.rpc("fn_processos_andamento_editar", {
      p_org: escrita.orgId,
      p_id: andamentoId,
      p_texto: texto,
    }),
    { requestId: escrita.requestId, andamentoId, action: "andamento.editado" },
  );
}
