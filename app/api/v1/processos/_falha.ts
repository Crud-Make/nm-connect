/**
 * A tradução de uma falha do banco para a resposta HTTP — uma só para as rotas de processos.
 *
 * Compartilhada porque a MESMA causa tem de produzir o MESMO código nas quatro rotas: a tela
 * escolhe o que mostrar pelo `error.code`, e o módulo não instalado é o caso que ela trata à
 * parte (mesmo desenho de `app/api/v1/external-db/_falha.ts`).
 *
 * Módulo de tabela (ADR-0002): antes da instalação a tabela não existe. Pela REST o PostgREST
 * responde PGRST205 (não está no cache do schema); dentro das RPCs, o Postgres responde 42P01.
 */
import { randomUUID } from "node:crypto";

import type { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import { andamentoTextoSchema } from "@/lib/schemas/processos";

const MODULO_NAO_INSTALADO =
  "O módulo de processos não está instalado nesta instalação. Peça ao administrador para " +
  "instalar em Configurações da instalação › Módulos.";

type ErroDoBanco = { code?: string; message?: string };

/**
 * @param invalido a frase da referência recusada (FK composta ou RLS de outra organização) —
 *   "Contato inválido…" no processo, "Processo inválido…" no andamento.
 */
export function respostaDaFalha(
  error: ErroDoBanco,
  requestId: string,
  invalido: string,
): NextResponse<ApiError> {
  if (error.code === "42P01" || error.code === "PGRST205") {
    return fail("module_not_installed", MODULO_NAO_INSTALADO, 409, { requestId });
  }
  // As recusas nomeadas das RPCs vêm antes do código: `processos_forbidden` sai com 42501, o
  // mesmo código que a RLS dá à linha de outra organização.
  if (error.message === "processos_forbidden") {
    return fail("forbidden_role", "Papel insuficiente.", 403, { requestId });
  }
  if (error.message === "andamento_nao_encontrado") {
    return fail("not_found", "Andamento não encontrado.", 404, { requestId });
  }
  if (error.message === "andamento_ja_aprovado") {
    return fail("validation_failed", "Este andamento já está aprovado.", 422, { requestId });
  }
  if (error.code === "23503" || error.code === "42501") {
    return fail("validation_failed", invalido, 422, { requestId });
  }
  if (error.code === "23505") {
    return fail("validation_failed", "Já existe um processo com este número CNJ.", 422, {
      requestId,
    });
  }
  return fail("internal_error", "Erro no módulo de processos.", 500, { requestId });
}

/** O primeiro problema do Zod como 422 — a régua das rotas de honorários. */
export function corpoInvalido(
  issues: ReadonlyArray<{ message: string }>,
  requestId: string,
): NextResponse<ApiError> {
  return fail("validation_failed", issues[0]?.message ?? "corpo inválido", 422, { requestId });
}

type Escrita<T> =
  | { ok: true; requestId: string; orgId: string; userId: string; dados: T }
  | { ok: false; resposta: NextResponse<ApiError> };

/**
 * A abertura comum das escritas com corpo: o `requestId`, o papel mínimo e o corpo validado
 * pelo schema. A guarda de suporte (`requireSupportWrite(`) fica no handler, antes desta
 * chamada — é lá que `tests/unit/suporte-cobertura-de-efeitos.test.ts` a procura.
 */
export async function abrirEscrita<T>(
  req: Request,
  schema: ZodType<T>,
  { papel, recurso }: { papel: Role; recurso: string },
): Promise<Escrita<T>> {
  const requestId = randomUUID();
  const authz = await requireRole(papel, { requestId, resource: recurso });
  if (!authz.ok) return { ok: false, resposta: authz.response };
  const lido = schema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return { ok: false, resposta: corpoInvalido(lido.error.issues, requestId) };
  return { ok: true, requestId, orgId: authz.org.orgId, userId: authz.user.id, dados: lido.data };
}

/**
 * Lançar e editar andamento abrem igual: `agent`+, o texto validado e o id do caminho (o do
 * processo em `/processos/[id]/andamentos`, o do andamento em `/processos/andamentos/[id]`).
 */
export async function abrirEscritaDeAndamento(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Escrita<{ texto: string; id: string }>> {
  const escrita = await abrirEscrita(req, andamentoTextoSchema, {
    papel: "agent",
    recurso: "andamentos",
  });
  if (!escrita.ok) return escrita;
  return { ...escrita, dados: { ...escrita.dados, id: (await ctx.params).id } };
}
