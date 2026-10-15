"use client";

import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useAttendants } from "@/hooks/team/useAttendants";
import {
  useAtualizarSetor,
  useCriarSetor,
  useExcluirSetor,
  useSetores,
  type Setor,
} from "@/hooks/team/useSetores";
import { NOME_DO_SETOR_MAX } from "@/lib/setores/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash } from "@/lib/ui/icons";

/**
 * Aba "Setores" de Equipe (migration 0675).
 *
 * Um setor é um grupo de atendentes. O Roteador de IA leva a conversa para um
 * setor quando a intenção casada aponta um (editor do roteador, campo
 * "Setor"); a partir daí só membros do setor recebem a conversa no
 * roteamento humano. Sem ninguém do setor de plantão, a conversa espera na
 * fila — e a fila mostra o setor.
 */
export function SetoresClient({ canManage }: { canManage: boolean }) {
  const t = useT();
  const { data, isLoading } = useSetores();
  const { data: equipeRes } = useAttendants();
  const setores = data?.data ?? [];
  const equipe = useMemo(
    () =>
      (equipeRes?.data ?? [])
        .filter((p) => p.role !== "viewer")
        .map((p) => ({ id: p.user_id, nome: p.name || p.email || p.user_id })),
    [equipeRes],
  );
  const nomePorId = useMemo(() => new Map(equipe.map((p) => [p.id, p.nome])), [equipe]);

  const [editando, setEditando] = useState<Setor | "novo" | null>(null);
  const [excluindo, setExcluindo] = useState<Setor | null>(null);
  const excluir = useExcluirSetor();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Setores agrupam quem atende cada área. Quando o roteador de IA leva a conversa para um setor, só os membros dele a recebem; se ninguém do setor estiver de plantão, ela espera na fila.",
          )}
        </p>
        {canManage ? (
          <Button onClick={() => setEditando("novo")} className="shrink-0">
            <Plus />
            {t("Novo setor")}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : setores.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("Nenhum setor ainda. Crie um para o roteador de IA poder encaminhar conversas por área.")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="lista-de-setores">
          {setores.map((setor) => (
            <li key={setor.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{setor.nome}</p>
                {setor.membros.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Sem membros — enquanto estiver vazio, o setor não restringe quem recebe.")}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {setor.membros.map((id) => (
                      <Badge key={id} variant="secondary">
                        {nomePorId.get(id) ?? t("Membro sem nome")}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              {canManage ? (
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditando(setor)}>
                    {t("Editar")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setExcluindo(setor)}
                    aria-label={t("Excluir setor")}
                  >
                    <Trash />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editando !== null ? (
        <EditorDeSetor
          setor={editando === "novo" ? null : editando}
          equipe={equipe}
          onClose={() => setEditando(null)}
        />
      ) : null}

      <AlertDialog open={excluindo !== null} onOpenChange={(open) => (open ? null : setExcluindo(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Excluir setor?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "As conversas e as intenções do roteador que apontam para este setor ficam sem setor. Nenhuma conversa é apagada.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (excluindo) excluir.mutate(excluindo.id);
                setExcluindo(null);
              }}
            >
              {t("Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EditorDeSetor({
  setor,
  equipe,
  onClose,
}: {
  setor: Setor | null;
  equipe: Array<{ id: string; nome: string }>;
  onClose: () => void;
}) {
  const t = useT();
  const [nome, setNome] = useState(setor?.nome ?? "");
  const [membros, setMembros] = useState<Set<string>>(() => new Set(setor?.membros ?? []));
  const criar = useCriarSetor();
  const atualizar = useAtualizarSetor();
  const salvando = criar.isPending || atualizar.isPending;
  const nomeValido = nome.trim().length > 0;

  const alternar = (id: string) =>
    setMembros((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });

  const salvar = () => {
    const body = { nome: nome.trim(), membros: [...membros] };
    const fechar = { onSuccess: onClose };
    if (setor === null) criar.mutate(body, fechar);
    else atualizar.mutate({ id: setor.id, patch: body }, fechar);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{setor === null ? t("Novo setor") : t("Editar setor")}</DialogTitle>
          <DialogDescription>
            {t("Dê um nome à área e marque quem atende por ela.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <Label htmlFor="nome-do-setor">{t("Nome do setor")}</Label>
            <Input
              id="nome-do-setor"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex.: Tributário")}
              maxLength={NOME_DO_SETOR_MAX}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Membros")}</legend>
            {equipe.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("Ninguém da equipe atende conversas ainda.")}</p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
                {equipe.map((pessoa) => (
                  <li key={pessoa.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={membros.has(pessoa.id)}
                        onChange={() => alternar(pessoa.id)}
                      />
                      <span className="truncate">{pessoa.nome}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={salvando}>
            {t("Cancelar")}
          </Button>
          <Button onClick={salvar} disabled={!nomeValido || salvando}>
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
