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
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";

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
