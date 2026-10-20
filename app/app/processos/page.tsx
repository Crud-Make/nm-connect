import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { ListaDeProcessos } from "./_client";

export const dynamic = "force-dynamic";

/**
 * PROCESSOS — o índice dos processos da organização (módulo `processos`, ADR-0002).
 *
 * Só leitura: cadastrar processo, lançar e aprovar andamento acontecem na ficha do contato,
 * onde está a pessoa e a conversa com ela. Cada linha leva até lá.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Processos")}</h1>
        <p className="text-sm text-text-muted">
          {t("Os processos de cada cliente, com a fase e o número CNJ.")}
        </p>
      </div>
      <ListaDeProcessos />
    </div>
  );
}
