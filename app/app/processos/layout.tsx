import { notFound } from "next/navigation";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Processos é MÓDULO DE TABELA do ADR-0002: `processos` e `andamentos` nascem em
 * `fn_processos_provisionar()` (migration 0707) e só existem onde `modulos_instalados` tem a
 * linha `processos` ativa. Desinstalado, esta tela não existe — o mesmo desenho de
 * `/app/comandas`: a porta some, não abre vazia.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  if (!(await moduloLigado(createAdminClient(), "processos"))) notFound();
  return children;
}
