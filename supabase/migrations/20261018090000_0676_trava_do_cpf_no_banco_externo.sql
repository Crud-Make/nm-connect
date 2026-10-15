-- manifest: **A trava do CPF no banco externo (issue #18).** Coluna `external_db_connections.require_cpf_check` (default false — nenhuma conexão existente muda), com CHECK que só a aceita ligada junto da chave do cliente por telefone; a view `external_db_connections_safe` passa a expô-la. Tabela nova `verificacoes_de_identidade` (organização, contato, conexão, `verificado_ate`, `tentativas_falhas`, `bloqueado_ate`): o estado da conferência dos 3 últimos dígitos do CPF que `crm_confirm_customer_identity` grava e `crm_query_external_data` lê antes de consultar na conversa. RLS por organização, leitura para membros, escrita só do servidor. Nenhuma função nova.
--
-- 0676 · a trava do CPF.
--
-- Por que a regra "trava pede chave por telefone" mora num CHECK, e não só no
-- Zod: o PATCH é parcial. Quem liga a trava sem mandar a chave não tem a linha
-- inteira à vista na validação do corpo — o banco tem. Nenhuma linha existente
-- viola o CHECK: a coluna nasce `false`.
--
-- Por que uma tabela, e não colunas em `contacts`: o estado é por CONEXÃO (cada
-- banco externo confere a sua base), e é de segurança, não do cadastro — a
-- ficha do contato não tem por que carregar contagem de erro de CPF.
--
-- Nenhum dado pessoal é guardado: nem CPF, nem dígitos, nem telefone. Só prazos
-- e uma contagem. O CPF fica no banco externo, que só responde `boolean`.
--
-- Idempotente: `add column if not exists`, constraint com drop+add, view com
-- drop+create, tabela e índices com `if not exists`, policy com drop+create,
-- grants refeitos.

alter table public.external_db_connections
  add column if not exists require_cpf_check boolean not null default false;

alter table public.external_db_connections
  drop constraint if exists external_db_connections_cpf_exige_telefone;

alter table public.external_db_connections
  add constraint external_db_connections_cpf_exige_telefone
    check (not require_cpf_check or customer_key_kind = 'phone');

comment on column public.external_db_connections.require_cpf_check is
  'A trava do CPF: na conversa, a consulta do agente a esta conexão só sai depois de o contato acertar os 3 últimos dígitos do CPF (ia.conferir_cpf no banco externo). Exige customer_key_kind = phone. Fora da conversa nada muda.';

drop view if exists public.external_db_connections_safe;
create view public.external_db_connections_safe
  with (security_invoker = true)
  as
  select id, organization_id, label, host, port, database_name, username,
         ssl_mode, enabled, max_rows, max_filters, max_response_bytes,
         customer_key_column, customer_key_kind, require_cpf_check,
         last_tested_at, last_test_ok, last_test_error,
         created_by, created_at, updated_at
  from public.external_db_connections;

revoke all on public.external_db_connections_safe from anon;
grant select on public.external_db_connections_safe to authenticated;

create table if not exists public.verificacoes_de_identidade (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  contact_id        uuid not null references public.contacts(id) on delete cascade,
  connection_id     uuid not null references public.external_db_connections(id) on delete cascade,
  verificado_ate    timestamptz,
  tentativas_falhas integer not null default 0,
  bloqueado_ate     timestamptz,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  constraint verificacoes_de_identidade_unica unique (organization_id, contact_id, connection_id),
  constraint verificacoes_de_identidade_tentativas_validas check (tentativas_falhas between 0 and 100)
);

comment on table public.verificacoes_de_identidade is
  'Estado da conferência de CPF (a trava do banco externo, issue #18): até quando o contato está conferido nesta conexão, quantos erros seguidos e até quando está bloqueado. Nenhum CPF, dígito ou telefone é guardado. Escrita só pelo servidor (crm_confirm_customer_identity).';

-- O leitor do índice é a conexão apagada (FK em cascata); a consulta do turno
-- usa a constraint única.
create index if not exists verificacoes_de_identidade_por_conexao
  on public.verificacoes_de_identidade (connection_id);

alter table public.verificacoes_de_identidade enable row level security;

-- Leitura pelo login, escrita SÓ pelo servidor. `revoke all` primeiro porque o
-- default ACL do baseline concede tudo a `authenticated` em tabela nova: sem
-- ele, um membro poderia zerar o próprio bloqueio pela REST.
revoke all    on public.verificacoes_de_identidade from anon, authenticated;
grant  select on public.verificacoes_de_identidade to authenticated;
grant  all    on public.verificacoes_de_identidade to service_role;

drop policy if exists tenant_isolation_verificacoes_de_identidade_select on public.verificacoes_de_identidade;
create policy tenant_isolation_verificacoes_de_identidade_select on public.verificacoes_de_identidade
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));
