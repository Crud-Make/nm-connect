import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * A abertura das páginas de organização: quem está logado, a organização ativa (sem ela, volta
 * para `/app`) e o `t` no idioma da pessoa. Repetida à mão em várias páginas de `app/app`.
 */
export async function exigirOrgDaPagina(): Promise<{
  user: AuthUser;
  org: ActiveOrg;
  t: (texto: string) => string;
}> {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return { user, org, t: (texto) => traduzir(texto, user.idioma) };
}
