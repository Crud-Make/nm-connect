-- manifest: **Setores do atendimento (NM Connect).** O handoff da IA para humano escolhia o atendente só pelo NÚMERO (`channel_routing_policies`); não havia como dizer "dúvida tributária vai para quem é do Tributário". Nascem `setores` (nome único por organização, sem diferenciar maiúsculas) e `setor_membros` (quem é de cada setor, FK composta com `user_organizations`, cascata ao revogar/apagar), `conversations.setor_id` e `ai_router_members.setor_id` — os dois com FK composta com a organização e `on delete set null (setor_id)`: setor excluído zera só o ponteiro, a conversa e a intenção seguem. O roteador grava o setor da intenção casada na conversa; o roteamento humano (`lib/routing/eligibles.ts`) restringe os elegíveis aos membros do setor e, sem ninguém do setor elegível, a conversa fica na fila. `NULL` em tudo = comportamento de antes. RLS: leitura para membros da organização, escrita só manager+ (`fn_role_at_least`); as rotas escrevem pelo service role com `organization_id` da sessão. Mesmo bloco no fim do `supabase/baseline.sql` (não cria função, fica depois da VARREDURA anon). Gate: `tests/invariants/setores-rls.test.ts`.

-- ---- setores do atendimento (migration 0675) ----
-- O roteamento humano escolhia por NÚMERO. Escritório com Empresarial,
-- Tributário e Previdenciário atrás do mesmo WhatsApp não tinha como mandar a
-- dúvida de cada área para quem é da área. O Roteador de IA já classifica a
-- intenção; agora a intenção pode apontar um SETOR, a conversa guarda o setor
-- (`conversations.setor_id`) e o roteamento humano só escolhe entre os membros
-- dele. Sem setor configurado nada muda.

create table if not exists public.setores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

-- Dois "Tributário" na mesma empresa seriam o mesmo setor com duas listas de
-- membros: a intenção apontaria um e a equipe editaria o outro.
create unique index if not exists setores_org_nome_unico
  on public.setores (organization_id, lower(nome));

create table if not exists public.setor_membros (
  setor_id uuid not null,
  user_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (setor_id, user_id),
  foreign key (organization_id, setor_id)
    references public.setores (organization_id, id) on delete cascade,
  -- Membro só da MESMA organização; sair da equipe (linha apagada) tira do setor.
  foreign key (organization_id, user_id)
    references public.user_organizations (organization_id, user_id) on delete cascade
);
create index if not exists setor_membros_org_user
  on public.setor_membros (organization_id, user_id);

alter table public.conversations add column if not exists setor_id uuid;
do $$ begin
  alter table public.conversations
    add constraint conversations_setor_mesma_org
    foreign key (organization_id, setor_id)
    references public.setores (organization_id, id)
    on delete set null (setor_id);
exception when duplicate_object then null; end $$;
create index if not exists idx_conversations_org_setor
  on public.conversations (organization_id, setor_id)
  where setor_id is not null;
comment on column public.conversations.setor_id is
  'Setor do atendimento (0675). Gravado pelo Roteador de IA quando a intenção casada aponta setor; o roteamento humano só escolhe membros dele. NULL = sem setor (comportamento de antes).';

alter table public.ai_router_members add column if not exists setor_id uuid;
do $$ begin
  alter table public.ai_router_members
    add constraint ai_router_members_setor_mesma_org
    foreign key (organization_id, setor_id)
    references public.setores (organization_id, id)
    on delete set null (setor_id);
exception when duplicate_object then null; end $$;
comment on column public.ai_router_members.setor_id is
  'Setor para onde a intenção leva a conversa (0675). NULL = a intenção não muda o setor.';

alter table public.setores enable row level security;
alter table public.setor_membros enable row level security;
revoke all on public.setores, public.setor_membros from public, anon;
grant select, insert, update, delete on public.setores, public.setor_membros to authenticated;
grant all on public.setores, public.setor_membros to service_role;

-- Leitura: todo membro da organização (a inbox mostra o setor da conversa).
drop policy if exists tenant_isolation_setores_select on public.setores;
create policy tenant_isolation_setores_select on public.setores
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
-- Escrita: configuração de equipe, manager+ (mesma régua das rotas).
drop policy if exists tenant_isolation_setores_all on public.setores;
create policy tenant_isolation_setores_all on public.setores
  for all to authenticated
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));

drop policy if exists tenant_isolation_setor_membros_select on public.setor_membros;
create policy tenant_isolation_setor_membros_select on public.setor_membros
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_setor_membros_all on public.setor_membros;
create policy tenant_isolation_setor_membros_all on public.setor_membros
  for all to authenticated
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));

notify pgrst, 'reload schema';
