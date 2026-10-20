import { PaginaDeModulo } from "@/components/layout/PaginaDeModulo";
import { exigirOrgDaPagina } from "@/lib/auth/org-da-pagina";

import { ListaDeProcessos } from "./_client";

export const dynamic = "force-dynamic";

/**
 * PROCESSOS — o índice dos processos da organização (módulo `processos`, ADR-0002).
 *
 * Só leitura: cadastrar processo, lançar e aprovar andamento acontecem na ficha do contato,
 * onde está a pessoa e a conversa com ela. Cada linha leva até lá.
 */
export default async function Page() {
  const { t } = await exigirOrgDaPagina();

  return (
    <PaginaDeModulo
      titulo={t("Processos")}
      descricao={t("Os processos de cada cliente, com a fase e o número CNJ.")}
    >
      <ListaDeProcessos />
    </PaginaDeModulo>
  );
}
