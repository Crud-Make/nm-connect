"use client";
/**
 * Leitura e escrita do módulo Processos pela tela — a lista de `/app/processos` e o painel da
 * ficha do contato leem pelos MESMOS hooks, e toda escrita invalida a mesma raiz de chave.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Andamento, Processo } from "@/lib/schemas/processos";

const RAIZ = "processos";

/** Sem `contactId`, os processos da organização inteira (a lista). */
export function useProcessos(contactId?: string) {
  return useQuery({
    queryKey: [RAIZ, { contactId }],
    retry: false,
    queryFn: async () => {
      const filtro = contactId ? `?contact_id=${contactId}` : "";
      return (await apiClient.get<{ data: Processo[] }>(`/api/v1/processos${filtro}`)).data;
    },
  });
}

export function useAndamentos(processoId: string) {
  return useQuery({
    queryKey: [RAIZ, processoId, "andamentos"],
    retry: false,
    queryFn: async () =>
      (await apiClient.get<{ data: Andamento[] }>(`/api/v1/processos/${processoId}/andamentos`)).data,
  });
}

/** Uma escrita do módulo: ao dar certo, tudo que foi lido de processos é relido. */
export function useEscritaDeProcessos<V>(escrever: (variaveis: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: escrever,
    onSuccess: () => qc.invalidateQueries({ queryKey: [RAIZ] }),
    onError: showApiError,
  });
}
