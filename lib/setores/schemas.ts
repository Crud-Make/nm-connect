/**
 * Entrada das rotas de setores (`/api/v1/setores`). `organization_id` nunca
 * vem do corpo — `.strict()` recusa o campo em vez de ignorá-lo, para que um
 * cliente que o mande descubra o erro em vez de achar que escolheu a empresa.
 */
import { z } from "zod";

/** O mesmo teto do CHECK da migration 0675 (`length(btrim(nome)) between 1 and 80`). */
export const NOME_DO_SETOR_MAX = 80;

const nome = z.string().trim().min(1).max(NOME_DO_SETOR_MAX);
/** Lista que SUBSTITUI os membros; repetição vira um só (a PK recusaria o par). */
const membros = z
  .array(z.string().uuid())
  .max(500)
  .transform((ids) => [...new Set(ids)]);

export const criarSetorSchema = z
  .object({ nome, membros: membros.default([]) })
  .strict();

export const atualizarSetorSchema = z
  .object({ nome: nome.optional(), membros: membros.optional() })
  .strict()
  .refine((b) => b.nome !== undefined || b.membros !== undefined, {
    message: "informe nome ou membros",
  });

export type CriarSetor = z.infer<typeof criarSetorSchema>;
export type AtualizarSetor = z.infer<typeof atualizarSetorSchema>;
