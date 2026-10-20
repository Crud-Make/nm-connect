"use client";
/**
 * Os andamentos de UM processo, na ficha do contato.
 *
 * O texto do andamento é o que o cliente vai ouvir, palavra por palavra — por isso o aprovado
 * e o rascunho se distinguem à vista, e só um gerente aprova. O que cada papel enxerga é da
 * RLS (migration 0707): `viewer` vê só o aprovado; quem escreve vê também os rascunhos.
 */
import { useState } from "react";
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAndamentos, useEscritaDeProcessos } from "@/hooks/processos/useProcessos";
import { apiClient } from "@/lib/api/client";
import type { Andamento } from "@/lib/schemas/processos";

interface Props {
  processoId: string;
  /** agent+: lança andamento e edita rascunho. */
  podeEscrever: boolean;
  /** manager+: aprova o rascunho. */
  podeAprovar: boolean;
}

export function AndamentosDoProcesso({ processoId, podeEscrever, podeAprovar }: Props) {
  const t = useT();
  const andamentos = useAndamentos(processoId);
  const lancar = useEscritaDeProcessos((texto: string) =>
    apiClient.post(`/api/v1/processos/${processoId}/andamentos`, { texto }),
  );

  if (andamentos.isError) {
    return <p className="text-sm text-error-fg">{t("Não foi possível carregar os andamentos.")}</p>;
  }

  const lista = andamentos.data ?? [];
  return (
    <div className="space-y-2">
      {lista.length === 0 && !andamentos.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum andamento ainda.")}</p>
      ) : (
        <ul className="space-y-2">
          {lista.map((a) => (
            <ItemDoAndamento key={a.id} andamento={a} podeEscrever={podeEscrever} podeAprovar={podeAprovar} />
          ))}
        </ul>
      )}
      {podeEscrever && (
        <FormularioDeTexto
          rotulo={t("Lançar andamento")}
          salvando={lancar.isPending}
          aoSalvar={(texto) => lancar.mutateAsync(texto)}
        />
      )}
    </div>
  );
}

function ItemDoAndamento({
  andamento,
  podeEscrever,
  podeAprovar,
}: { andamento: Andamento } & Omit<Props, "processoId">) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const [editando, setEditando] = useState(false);
  const caminho = `/api/v1/processos/andamentos/${andamento.id}`;
  const editar = useEscritaDeProcessos((texto: string) => apiClient.patch(caminho, { texto }));
  const aprovar = useEscritaDeProcessos(() => apiClient.post(`${caminho}/aprovar`, {}));
  const rascunho = andamento.status === "rascunho";

  if (editando) {
    return (
      <li>
        <FormularioDeTexto
          rotulo={t("Salvar")}
          inicial={andamento.texto}
          salvando={editar.isPending}
          aoSalvar={async (texto) => {
            await editar.mutateAsync(texto);
            setEditando(false);
          }}
          aoCancelar={() => setEditando(false)}
        />
      </li>
    );
  }

  return (
    <li className="rounded-md border bg-background p-3" data-testid={`andamento-${andamento.id}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {rascunho ? (
          <Badge variant="warning">{t("Rascunho")}</Badge>
        ) : (
          <Badge variant="success">{t("Aprovado")}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {format(new Date(andamento.aprovado_em ?? andamento.created_at), "dd/MM/yyyy HH:mm", {
            locale: localeDaData,
          })}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{andamento.texto}</p>
      {rascunho && (podeEscrever || podeAprovar) && (
        <div className="mt-2 flex gap-2">
          {podeAprovar && (
            <Button size="sm" disabled={aprovar.isPending} onClick={() => aprovar.mutate(undefined)}>
              {aprovar.isPending ? t("Aprovando…") : t("Aprovar")}
            </Button>
          )}
          {podeEscrever && (
            <Button size="sm" variant="outline" onClick={() => setEditando(true)}>
              {t("Editar")}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Lançar e editar pedem a mesma coisa: o texto para o cliente. */
function FormularioDeTexto({
  rotulo,
  inicial = "",
  salvando,
  aoSalvar,
  aoCancelar,
}: {
  rotulo: string;
  inicial?: string;
  salvando: boolean;
  aoSalvar: (texto: string) => Promise<unknown>;
  aoCancelar?: () => void;
}) {
  const t = useT();
  const [texto, setTexto] = useState(inicial);
  const pode = !salvando && texto.trim() !== "";

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pode) return;
        // Limpa só quando gravou: falha de rede mantém o texto para tentar de novo.
        void aoSalvar(texto.trim()).then(() => setTexto(inicial), () => undefined);
      }}
    >
      <Textarea
        value={texto}
        maxLength={2000}
        placeholder={t("O que aconteceu, escrito para o cliente ler.")}
        aria-label={t("Texto do andamento")}
        onChange={(e) => setTexto(e.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!pode}>
          {rotulo}
        </Button>
        {aoCancelar && (
          <Button type="button" size="sm" variant="outline" onClick={aoCancelar}>
            {t("Cancelar")}
          </Button>
        )}
      </div>
    </form>
  );
}
