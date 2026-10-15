"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

/** Setor do atendimento (migration 0675), com os user_ids dos membros. */
export interface Setor {
  id: string;
  nome: string;
  created_at: string;
  membros: string[];
}

export const SETORES_KEY = ["setores"] as const;

/** Setores da organização — qualquer membro lê (inbox, roteador, equipe). */
export function useSetores(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: SETORES_KEY,
    queryFn: async () => apiClient.get<{ data: Setor[] }>("/api/v1/setores"),
    staleTime: 60_000,
    enabled: opts?.enabled ?? true,
  });
}

/** id → nome, para a inbox nomear o setor sem uma consulta por conversa. */
export function nomesDosSetores(setores: readonly Setor[] | undefined): Map<string, string> {
  return new Map((setores ?? []).map((s) => [s.id, s.nome]));
}

export function useCriarSetor() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (body: { nome: string; membros: string[] }) =>
      apiClient.post<{ data: Setor }>("/api/v1/setores", body),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Setor criado."));
      void qc.invalidateQueries({ queryKey: SETORES_KEY });
    },
  });
}

export function useAtualizarSetor() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: { nome?: string; membros?: string[] } }) =>
      apiClient.patch<{ data: { id: string } }>(`/api/v1/setores/${id}`, patch),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Setor salvo."));
      void qc.invalidateQueries({ queryKey: SETORES_KEY });
    },
  });
}

export function useExcluirSetor() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete<{ data: { id: string } }>(`/api/v1/setores/${id}`),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Setor excluído."));
      void qc.invalidateQueries({ queryKey: SETORES_KEY });
    },
  });
}
