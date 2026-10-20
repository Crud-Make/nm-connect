import { z } from "zod";

/**
 * O CONTRATO DO MÓDULO PROCESSOS — um só, lido pelas rotas E pelas telas (padrão
 * `lib/schemas/propostas.ts`). As listas repetem os CHECK de `fn_processos_provisionar`
 * (migration 0707): o banco é quem recusa; aqui a recusa chega antes, com mensagem.
 */

export const AREAS_DO_PROCESSO = [
  "civel",
  "trabalhista",
  "familia",
  "previdenciario",
  "criminal",
  "tributario",
  "outra",
] as const;
export type AreaDoProcesso = (typeof AREAS_DO_PROCESSO)[number];

export const FASES_DO_PROCESSO = ["conhecimento", "recurso", "execucao", "arquivado"] as const;
export type FaseDoProcesso = (typeof FASES_DO_PROCESSO)[number];

/** Rótulos em português; a tela passa cada um por `t()`. */
export const ROTULO_DA_AREA: Record<AreaDoProcesso, string> = {
  civel: "Cível",
  trabalhista: "Trabalhista",
  familia: "Família",
  previdenciario: "Previdenciário",
  criminal: "Criminal",
  tributario: "Tributário",
  outra: "Outra",
};

export const ROTULO_DA_FASE: Record<FaseDoProcesso, string> = {
  conhecimento: "Conhecimento",
  recurso: "Recurso",
  execucao: "Execução",
  arquivado: "Arquivado",
};

/** NNNNNNN-DD.AAAA.J.TR.OOOO (Resolução CNJ 65/2008): a forma, não o dígito verificador. */
const NUMERO_CNJ = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;

export const processoCreateSchema = z.object({
  contact_id: z.string().uuid(),
  apelido: z.string().trim().min(1, "Dê um apelido ao processo.").max(120),
  // Nulo enquanto o processo não foi distribuído.
  numero_cnj: z
    .string()
    .trim()
    .regex(NUMERO_CNJ, "Número CNJ no formato 0000000-00.0000.0.00.0000.")
    .nullish(),
  area: z.enum(AREAS_DO_PROCESSO),
  fase: z.enum(FASES_DO_PROCESSO).default("conhecimento"),
});
export type ProcessoCreateInput = z.infer<typeof processoCreateSchema>;

/** Criar e editar andamento pedem a mesma coisa: o texto que vai PARA O CLIENTE. */
export const andamentoTextoSchema = z.object({
  texto: z.string().trim().min(1, "Escreva o andamento.").max(2000),
});

export const listarProcessosQuerySchema = z.object({
  contact_id: z.string().uuid().optional(),
});

export type Processo = {
  id: string;
  contact_id: string;
  numero_cnj: string | null;
  apelido: string;
  area: AreaDoProcesso;
  fase: FaseDoProcesso;
  created_at: string;
  contacts: { name: string | null; display_name: string | null; phone_number: string | null } | null;
};

export type Andamento = {
  id: string;
  processo_id: string;
  texto: string;
  status: "rascunho" | "aprovado";
  aprovado_em: string | null;
  created_at: string;
};
