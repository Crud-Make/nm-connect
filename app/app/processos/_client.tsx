"use client";
/**
 * A lista de processos da organização: apelido, número CNJ, cliente e fase, com o caminho para
 * a ficha do contato — é lá que o processo se trabalha.
 */
import Link from "next/link";

import { useProcessos } from "@/hooks/processos/useProcessos";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { ROTULO_DA_FASE } from "@/lib/schemas/processos";

export function ListaDeProcessos() {
  const t = useT();
  const processos = useProcessos();

  if (processos.isError) {
    return <p className="text-sm text-danger">{t("Não foi possível carregar os processos.")}</p>;
  }

  const linhas = processos.data ?? [];
  return (
    <section className="rounded-md border border-border p-3">
      {linhas.length === 0 ? (
        <p className="text-sm text-text-muted">
          {processos.isLoading
            ? t("Carregando…")
            : t("Nenhum processo ainda. Cadastre o primeiro na ficha do cliente.")}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted">
              <th className="py-2 font-medium">{t("Apelido")}</th>
              <th className="py-2 font-medium">{t("Número CNJ")}</th>
              <th className="py-2 font-medium">{t("Cliente")}</th>
              <th className="py-2 font-medium">{t("Fase")}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((p) => (
              <tr key={p.id} className="border-b border-border/60" data-testid={`processo-${p.id}`}>
                <td className="py-2 font-medium">{p.apelido}</td>
                <td className="py-2 tabular-nums text-text-muted">{p.numero_cnj ?? "—"}</td>
                <td className="py-2">
                  <Link href={`/app/contacts/${p.contact_id}?secao=processos`} className="text-accent hover:underline">
                    {rotuloDoContato(p.contacts, t)}
                  </Link>
                </td>
                <td className="py-2">{t(ROTULO_DA_FASE[p.fase])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
