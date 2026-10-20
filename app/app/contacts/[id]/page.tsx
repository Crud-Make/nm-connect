import { notFound, redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { paineisDaEntidade } from "@/lib/modulos/dados/paineis";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ContactDetailClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const { id } = await params;
  const supabase = await createClient();
  // Filtra a org ATIVA, não só a RLS: para quem é membro de duas organizações a
  // policy deixa passar as duas, e a tela abriria o contato da org que não está
  // selecionada — com o dossiê do cliente carregando vazio por baixo.
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!contact) notFound();
  // Resolvido no servidor: a lista de painéis de módulo não precisa de rota pública própria, e a
  // função nunca lança — ficha de contato é jornada do NÚCLEO, e não depende de extensão (nn.1).
  // A organização vem da SESSÃO (`resolveActiveOrg`, acima), nunca da URL: é ela que decide se
  // esta empresa chega a saber que o módulo existe. Ver o cabeçalho de `paineisDaEntidade`.
  const paineisDeModulo = await paineisDaEntidade("contato", activeOrg.orgId);
  // Módulo de TABELA (ADR-0002): decidido aqui, como o layout de `/app/processos`. Sem ele as
  // tabelas não existem, e o painel nem é montado — o client não consulta o módulo.
  const processosAtivo = await moduloLigado(createAdminClient(), "processos");
  return (
    <ContactDetailClient
      contactId={id}
      paineisDeModulo={paineisDeModulo}
      processosAtivo={processosAtivo}
    />
  );
}
