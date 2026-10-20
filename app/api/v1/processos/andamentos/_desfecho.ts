/**
 * O desfecho comum de EDITAR e APROVAR um andamento.
 *
 * As duas rotas são uma RPC da migration 0707 (`fn_processos_andamento_editar` e
 * `fn_processos_andamento_aprovar`) que devolve a linha gravada; o que muda entre elas é a
 * função chamada e o código de auditoria. A recusa sai pela tradução única do módulo.
 */
import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";

import { respostaDaFalha } from "../_falha";

type Rpc = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

export async function desfechoDaRpc(
  chamada: Rpc,
  { requestId, andamentoId, action }: { requestId: string; andamentoId: string; action: AuditAction },
): Promise<Response> {
  const { data, error } = await chamada;
  if (error) return respostaDaFalha(error, requestId, "Andamento inválido para esta organização.");

  await audit({
    action,
    resourceType: "andamento",
    resourceId: andamentoId,
    requestId,
    metadata: { processo_id: (data as { processo_id: string }).processo_id },
  });

  return ok(data, { requestId });
}
