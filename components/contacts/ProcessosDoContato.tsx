"use client";
/**
 * PROCESSOS DO CLIENTE, na ficha do contato (módulo `processos`, migration 0707).
 *
 * Fica na ficha, e não só em `/app/processos`, porque é aqui que o trabalho acontece: lançar o
 * andamento de alguém exige ver quem é a pessoa e o que já foi dito a ela. Quem decide se o
 * módulo está instalado é o SERVIDOR (`contacts/[id]/page.tsx`); este componente só é montado
 * quando está, e não consulta o módulo.
 */
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { useEscritaDeProcessos, useProcessos } from "@/hooks/processos/useProcessos";
import { apiClient } from "@/lib/api/client";
import {
  AREAS_DO_PROCESSO,
  FASES_DO_PROCESSO,
  ROTULO_DA_AREA,
  ROTULO_DA_FASE,
  type AreaDoProcesso,
  type FaseDoProcesso,
  type ProcessoCreateInput,
} from "@/lib/schemas/processos";
import { ScalesSimple } from "@/lib/ui/icons";

import { AndamentosDoProcesso } from "./AndamentosDoProcesso";

interface Props {
  contactId: string;
  /** agent+: cadastra processo, lança e edita andamento. */
  podeEscrever: boolean;
  /** manager+: aprova andamento. */
  podeAprovar: boolean;
}

export function ProcessosDoContato({ contactId, podeEscrever, podeAprovar }: Props) {
  const t = useT();
  const processos = useProcessos(contactId);
  const [cadastrando, setCadastrando] = useState(false);

  const lista = processos.data ?? [];
  return (
    <Card className="space-y-4 p-4" data-testid="processos-do-contato">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ScalesSimple size={16} aria-hidden className="text-text-muted" />
          {t("Processos")}
        </h3>
        {podeEscrever && !cadastrando && (
          <Button size="sm" variant="outline" onClick={() => setCadastrando(true)}>
            {t("Cadastrar processo")}
          </Button>
        )}
      </div>

      {cadastrando && (
        <NovoProcesso contactId={contactId} aoTerminar={() => setCadastrando(false)} />
      )}

      {processos.isError && (
        <p className="text-sm text-error-fg">{t("Não foi possível carregar os processos.")}</p>
      )}
      {lista.length === 0 && processos.isSuccess && !cadastrando && (
        <p className="text-sm text-muted-foreground">{t("Nenhum processo deste cliente ainda.")}</p>
      )}

      {lista.map((p) => (
        <section key={p.id} className="space-y-2 border-t pt-3" data-testid={`processo-${p.id}`}>
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="font-medium">{p.apelido}</p>
            {p.numero_cnj && <span className="text-xs tabular-nums text-muted-foreground">{p.numero_cnj}</span>}
            <Badge variant="neutral">{t(ROTULO_DA_AREA[p.area])}</Badge>
            <Badge variant="info">{t(ROTULO_DA_FASE[p.fase])}</Badge>
          </div>
          <AndamentosDoProcesso processoId={p.id} podeEscrever={podeEscrever} podeAprovar={podeAprovar} />
        </section>
      ))}
    </Card>
  );
}

const CLASSE_DO_SELECT = "rounded-md border border-border bg-surface-elevated p-2 text-sm text-text";

function NovoProcesso({ contactId, aoTerminar }: { contactId: string; aoTerminar: () => void }) {
  const t = useT();
  const [apelido, setApelido] = useState("");
  const [numeroCnj, setNumeroCnj] = useState("");
  const [area, setArea] = useState<AreaDoProcesso>("civel");
  const [fase, setFase] = useState<FaseDoProcesso>("conhecimento");
  const criar = useEscritaDeProcessos((corpo: ProcessoCreateInput) =>
    apiClient.post("/api/v1/processos", corpo),
  );
  const pode = !criar.isPending && apelido.trim() !== "";

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pode) return;
        criar.mutate(
          { contact_id: contactId, apelido, numero_cnj: numeroCnj.trim() || null, area, fase },
          { onSuccess: aoTerminar },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Apelido")}
        <Input
          value={apelido}
          maxLength={120}
          placeholder={t("Ex.: Divórcio")}
          data-testid="processo-apelido"
          onChange={(e) => setApelido(e.target.value)}
          className="w-48"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Número CNJ (opcional)")}
        <Input
          value={numeroCnj}
          placeholder="0000000-00.0000.0.00.0000"
          data-testid="processo-numero-cnj"
          onChange={(e) => setNumeroCnj(e.target.value)}
          className="w-64"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Área")}
        <select value={area} onChange={(e) => setArea(e.target.value as AreaDoProcesso)} className={CLASSE_DO_SELECT}>
          {AREAS_DO_PROCESSO.map((a) => (
            <option key={a} value={a}>
              {t(ROTULO_DA_AREA[a])}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Fase")}
        <select value={fase} onChange={(e) => setFase(e.target.value as FaseDoProcesso)} className={CLASSE_DO_SELECT}>
          {FASES_DO_PROCESSO.map((f) => (
            <option key={f} value={f}>
              {t(ROTULO_DA_FASE[f])}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="sm" disabled={!pode} data-testid="criar-processo">
        {t("Cadastrar")}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={aoTerminar}>
        {t("Cancelar")}
      </Button>
    </form>
  );
}
