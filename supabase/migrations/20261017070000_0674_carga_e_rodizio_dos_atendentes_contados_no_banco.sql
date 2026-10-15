-- manifest: **Carga e rodízio dos atendentes contados no banco, sem o corte de 1000 linhas do PostgREST.** `lib/routing/eligibles.ts` (worker de roteamento, handoff v2, crm_get_queue_status) e `lib/escalacao/atendentes.ts` (roster da tela Equipe e crm_list_available_attendants) liam as linhas de `conversations` abertas e de `conversation_assignment_events` e contavam em memória; o `max_rows = 1000` do PostgREST corta sem erro, então com mais de 1000 conversas abertas ou eventos a carga saía subcontada, o teto de capacidade deixava passar quem estava cheio, a menor carga errava e o rodízio esquecia a última atribuição. Nova `fn_carga_e_rodizio_dos_atendentes(org, user_ids, statuses, canal)` (`security invoker`, `search_path` fixo, revogada de public/anon/authenticated, só `service_role`) devolve por atendente a contagem e a última atribuição (com escopo de canal), sempre filtrando a organização; índice parcial `idx_cae_org_destino_recente` em `conversation_assignment_events (organization_id, to_user_id, created_at desc)` serve o último evento por atendente. Mesmo bloco no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon. Gates: `lib/routing/eligibles.test.ts`, `tests/unit/attendants-availability-route.test.ts` (corte simulado de 1000 linhas) e `tests/invariants/carga-e-rodizio-contados-no-banco.test.ts` (1200 conversas, 1100 eventos, 2 organizações, canal, ACL).

-- 0674: carga e rodízio dos atendentes contados no banco.
--
-- O bloco abaixo é o MESMO, letra a letra, do apêndice de `supabase/baseline.sql`.

-- ---- carga e rodízio dos atendentes contados no banco (migration 0674) ----
-- O roteamento (`lib/routing/eligibles.ts`) e o roster de atendimento
-- (`lib/escalacao/atendentes.ts`) liam LINHAS para contar: `select
-- assigned_to_user_id` de toda conversa aberta atribuída, e
-- `conversation_assignment_events` inteiro para achar a última atribuição de
-- cada um. O PostgREST corta a resposta em `max_rows` (1000 no
-- `supabase/config.toml`; o Supabase Cloud usa o mesmo padrão) SEM erro: com
-- mais de 1000 conversas abertas ou 1000 eventos, a carga saía subcontada, o
-- teto de capacidade deixava passar quem já estava cheio, a "menor carga"
-- errava e o rodízio esquecia quem recebeu por último — tudo em silêncio.
--
-- Esta função devolve UMA linha por atendente pedido (jsonb, para caber num
-- só valor qualquer que seja o volume): `carga` (conversas da organização
-- atribuídas a ele com status em `p_statuses` — o chamador passa
-- `OPEN_LOAD_STATUSES`, a fonte única do que é carga) e
-- `ultima_atribuicao_em` (o evento mais novo em que ele foi o destino;
-- com `p_channel_session_id`, só nas conversas daquele canal).
--
-- `security invoker` e só `service_role` executa: os chamadores são o worker,
-- a capacidade do agente (MCP) e a rota do roster, todos com o client admin e
-- o `organization_id` resolvido no servidor. A organização é filtrada nas
-- duas tabelas e na conversa do evento — nunca há leitura sem ela.
--
-- O índice serve o `order by created_at desc limit 1` por atendente; sem ele
-- cada chamada varreria os eventos da organização inteira.

create index if not exists idx_cae_org_destino_recente
  on public.conversation_assignment_events (organization_id, to_user_id, created_at desc)
  where to_user_id is not null;

create or replace function public.fn_carga_e_rodizio_dos_atendentes(
  p_organization_id uuid,
  p_user_ids uuid[],
  p_statuses text[],
  p_channel_session_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'user_id', u.user_id,
               'carga', l.carga,
               'ultima_atribuicao_em', h.created_at
             )
             order by u.user_id
           ),
           '[]'::jsonb
         )
    from (select distinct x.user_id from unnest(p_user_ids) as x(user_id)) u
    cross join lateral (
      select count(*)::int as carga
        from public.conversations c
       where c.organization_id = p_organization_id
         and c.assigned_to_user_id = u.user_id
         and c.status = any(p_statuses)
    ) l
    left join lateral (
      select e.created_at
        from public.conversation_assignment_events e
       where e.organization_id = p_organization_id
         and e.to_user_id = u.user_id
         and (
           p_channel_session_id is null
           or exists (
             select 1
               from public.conversations ce
              where ce.id = e.conversation_id
                and ce.organization_id = p_organization_id
                and ce.channel_session_id = p_channel_session_id
           )
         )
       order by e.created_at desc
       limit 1
    ) h on true;
$fn$;

revoke all on function public.fn_carga_e_rodizio_dos_atendentes(uuid, uuid[], text[], uuid) from public, anon, authenticated;
grant execute on function public.fn_carga_e_rodizio_dos_atendentes(uuid, uuid[], text[], uuid) to service_role;
