import { PaginaDeModulo } from "@/components/layout/PaginaDeModulo";
import { exigirOrgDaPagina } from "@/lib/auth/org-da-pagina";
import { ROLE_RANK } from "@/lib/auth/types";

import { Honorarios } from "./_client";

export const dynamic = "force-dynamic";

/**
 * HONORÁRIOS — módulo opcional (ADR-0002): contrato de cobrança do caso (fixo,
 * êxito ou misto) e o calendário de parcelas que dele decorre.
 *
 * `viewer` lê; criar contrato e parcela, e marcar parcela como paga, exige
 * `manager`+ — dinheiro não é coisa que `agent` configure, mesma régua do
 * catálogo financeiro e da migration 0480.
 */
export default async function Page() {
  const { org, t } = await exigirOrgDaPagina();

  return (
    <PaginaDeModulo
      titulo={t("Honorários")}
      descricao={t("O modelo de cobrança de cada caso e o calendário de parcelas.")}
    >
      <Honorarios podeGerenciar={ROLE_RANK[org.role] >= ROLE_RANK.manager} />
    </PaginaDeModulo>
  );
}
