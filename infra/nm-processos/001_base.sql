-- ---------------------------------------------------------------------------
-- Banco de processos do escritório (Supabase SEPARADO do NM Connect).
--
-- O NM Connect só LÊ este banco, pelo conector de banco externo
-- (lib/external-db, tool crm_query_external_data), com o papel `crm_leitor`.
-- Desenho e decisões: issue #18.
--
-- Dois schemas, de propósito:
--   escritorio  as tabelas reais. Nem a IA nem a REST do Supabase as alcançam
--               (o schema não é exposto e nenhum papel da REST tem grant).
--   ia          a vitrine: duas views só com o que pode ir para o cliente, e a
--               função que confere o CPF. É tudo o que o `crm_leitor` enxerga.
--
-- Um banco por escritório, então não há coluna de organização.
-- Idempotente: pode ser reaplicado (o testar.sh aplica duas vezes).
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

create schema if not exists escritorio;
create schema if not exists ia;

-- ===========================================================================
-- Telefone: uma pessoa, duas grafias (nono dígito)
-- ===========================================================================

/*
 * O WhatsApp às vezes entrega o celular brasileiro SEM o nono dígito
 * (+55 31 8888-7777 em vez de +55 31 98888-7777). A forma canônica é a COM o
 * nono dígito, que é como o NM Connect guarda o contato. Fixo (local começando
 * de 2 a 5) e número estrangeiro ficam como vieram.
 */
create or replace function escritorio.telefone_canonico(p text)
returns text
language sql
immutable
strict
as $$
  select case
    when p ~ '^\+55[0-9]{2}[6-9][0-9]{7}$'
      then substr(p, 1, 5) || '9' || substr(p, 6)
    else p
  end
$$;

/* As grafias que o mesmo número pode ter. É o que a view usa para casar. */
create or replace function escritorio.variantes_do_telefone(p text)
returns text[]
language sql
immutable
strict
as $$
  select case
    when escritorio.telefone_canonico(p) ~ '^\+55[0-9]{2}9[6-9][0-9]{7}$'
      then array[
        escritorio.telefone_canonico(p),
        substr(escritorio.telefone_canonico(p), 1, 5) || substr(escritorio.telefone_canonico(p), 7)
      ]
    else array[p]
  end
$$;

-- ===========================================================================
-- Tabelas
-- ===========================================================================

/*
 * PESSOAS são quem fala no WhatsApp. CLIENTES são quem contrata: pessoa física
 * ou empresa. Na PF, a pessoa é a titular do próprio cliente; na PJ, sócio,
 * contador ou financeiro são pessoas AUTORIZADAS pela empresa. A conferência
 * do CPF é sempre de quem fala.
 */
create table if not exists escritorio.pessoas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  /* E.164, com o +DDI. Obrigatório: é a primeira barreira da consulta. */
  telefone_whatsapp text not null
    constraint pessoas_telefone_e164 check (telefone_whatsapp ~ '^\+[1-9][0-9]{9,14}$'),
  /*
   * Os 3 ÚLTIMOS dígitos do CPF, e só eles: a conferência não precisa de mais,
   * e o que não está aqui não vaza. Nunca o CPF inteiro.
   */
  cpf_confere text not null
    constraint pessoas_cpf_confere_3_digitos check (cpf_confere ~ '^[0-9]{3}$'),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

/*
 * Um telefone, uma pessoa — inclusive entre as grafias com e sem o nono
 * dígito. Com dois donos, o mesmo WhatsApp veria os processos dos dois.
 */
create unique index if not exists pessoas_telefone_unico
  on escritorio.pessoas (escritorio.telefone_canonico(telefone_whatsapp));

create table if not exists escritorio.clientes (
  id uuid primary key default gen_random_uuid(),
  tipo text not null
    constraint clientes_tipo_valido check (tipo in ('PF', 'PJ')),
  /* Nome da pessoa (PF) ou razão social (PJ). */
  nome text not null,
  /* Só na PJ, 14 dígitos sem máscara. Dado público da empresa. */
  cnpj text unique
    constraint clientes_cnpj_formato check (cnpj ~ '^[0-9]{14}$'),
  constraint clientes_cnpj_so_na_pj check ((tipo = 'PJ') = (cnpj is not null)),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

/* Quem fala em nome de cada cliente, e em que papel. */
create table if not exists escritorio.cliente_pessoas (
  cliente_id uuid not null references escritorio.clientes (id) on delete cascade,
  pessoa_id uuid not null references escritorio.pessoas (id) on delete cascade,
  papel text not null
    constraint cliente_pessoas_papel_valido
    check (papel in ('titular', 'socio', 'representante', 'contador', 'financeiro')),
  primary key (cliente_id, pessoa_id)
);
create index if not exists cliente_pessoas_pessoa on escritorio.cliente_pessoas (pessoa_id);

create table if not exists escritorio.processos (
  id uuid primary key default gen_random_uuid(),
  numero_cnj text not null unique
    constraint processos_numero_cnj_formato
    check (numero_cnj ~ '^[0-9]{7}-[0-9]{2}\.[0-9]{4}\.[0-9]\.[0-9]{2}\.[0-9]{4}$'),
  /* Como o cliente reconhece o processo: "Trabalhista contra Empresa X". */
  apelido text not null,
  area text,
  fase text,
  advogado_responsavel text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

/* Processo pode ter mais de um cliente (vários autores) e vice-versa. */
create table if not exists escritorio.cliente_processo (
  cliente_id uuid not null references escritorio.clientes (id) on delete cascade,
  processo_id uuid not null references escritorio.processos (id) on delete cascade,
  primary key (cliente_id, processo_id)
);
create index if not exists cliente_processo_processo on escritorio.cliente_processo (processo_id);

create table if not exists escritorio.andamentos (
  id uuid primary key default gen_random_uuid(),
  processo_id uuid not null references escritorio.processos (id) on delete cascade,
  data date not null,
  /* Linguagem simples, escrito para o cliente ler. Nunca o juridiquês bruto. */
  texto_para_cliente text not null,
  proximo_passo text,
  liberado_para_cliente boolean not null default false,
  revisado_por text,
  revisado_em timestamptz,
  criado_em timestamptz not null default now(),
  constraint andamentos_liberado_exige_revisao
    check (not liberado_para_cliente or (revisado_por is not null and revisado_em is not null))
);
create index if not exists andamentos_processo_data on escritorio.andamentos (processo_id, data desc);

/*
 * O dossiê do cliente: RG, CNIS, procuração, contrato de honorários, petições.
 * O arquivo mora num bucket PRIVADO do Storage deste projeto; aqui fica o
 * ponteiro. O processo é opcional, mas quando vem tem de ser do mesmo cliente
 * (a FK composta com `cliente_processo` garante). A IA não enxerga esta tabela.
 */
create table if not exists escritorio.documentos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references escritorio.clientes (id) on delete cascade,
  processo_id uuid,
  /* Vocabulário aberto de propósito: "rg", "cnis", "procuracao", "contrato_honorarios"... */
  tipo text not null,
  nome_arquivo text not null,
  caminho_storage text not null unique,
  origem text not null
    constraint documentos_origem_valida check (origem in ('whatsapp', 'equipe', 'email', 'tribunal')),
  enviado_por text,
  criado_em timestamptz not null default now(),
  constraint documentos_processo_do_cliente
    foreign key (cliente_id, processo_id)
    references escritorio.cliente_processo (cliente_id, processo_id) on delete cascade
);
create index if not exists documentos_cliente on escritorio.documentos (cliente_id, criado_em desc);

/*
 * Texto mudou depois de liberado → volta para revisão. O advogado aprovou
 * AQUELE texto, não o que veio depois. Só continua liberado quando o mesmo
 * update traz revisão nova (revisado_em diferente).
 */
create or replace function escritorio.andamento_volta_para_revisao()
returns trigger
language plpgsql
as $$
begin
  if new.liberado_para_cliente
     and (new.texto_para_cliente is distinct from old.texto_para_cliente
          or new.proximo_passo is distinct from old.proximo_passo)
     and new.revisado_em is not distinct from old.revisado_em then
    new.liberado_para_cliente := false;
  end if;
  return new;
end
$$;

drop trigger if exists andamento_volta_para_revisao on escritorio.andamentos;
create trigger andamento_volta_para_revisao
  before update on escritorio.andamentos
  for each row execute function escritorio.andamento_volta_para_revisao();

-- ===========================================================================
-- A vitrine da IA
-- ===========================================================================

/*
 * Um processo por linha, repetido para cada grafia do telefone de cada pessoa
 * que fala pelo cliente: o conector filtra `telefone in (+55..., 55..., ...)`
 * com o número da conversa, e a linha casa com ou sem o nono dígito. Só o
 * último andamento LIBERADO. `cliente` e `papel` deixam a IA dizer "o processo
 * da Empresa XYZ" quando quem fala é o contador.
 */
create or replace view ia.processos as
select
  t.telefone,
  c.nome as cliente,
  c.tipo as tipo_cliente,
  cpe.papel,
  p.apelido,
  p.numero_cnj,
  p.area,
  p.fase,
  p.advogado_responsavel,
  ua.data as data_ultimo_andamento,
  ua.texto_para_cliente as ultimo_andamento,
  ua.proximo_passo
from escritorio.pessoas pe
join escritorio.cliente_pessoas cpe on cpe.pessoa_id = pe.id
join escritorio.clientes c on c.id = cpe.cliente_id
join escritorio.cliente_processo cp on cp.cliente_id = c.id
join escritorio.processos p on p.id = cp.processo_id
cross join lateral unnest(escritorio.variantes_do_telefone(pe.telefone_whatsapp)) as t (telefone)
left join lateral (
  select a.data, a.texto_para_cliente, a.proximo_passo
  from escritorio.andamentos a
  where a.processo_id = p.id and a.liberado_para_cliente
  order by a.data desc, a.revisado_em desc
  limit 1
) ua on true;

/* O histórico, para "o que aconteceu antes?". Só liberados. */
create or replace view ia.andamentos as
select
  t.telefone,
  c.nome as cliente,
  p.apelido,
  p.numero_cnj,
  a.data,
  a.texto_para_cliente,
  a.proximo_passo
from escritorio.pessoas pe
join escritorio.cliente_pessoas cpe on cpe.pessoa_id = pe.id
join escritorio.clientes c on c.id = cpe.cliente_id
join escritorio.cliente_processo cp on cp.cliente_id = c.id
join escritorio.processos p on p.id = cp.processo_id
join escritorio.andamentos a on a.processo_id = p.id and a.liberado_para_cliente
cross join lateral unnest(escritorio.variantes_do_telefone(pe.telefone_whatsapp)) as t (telefone);

/*
 * A conferência do CPF de QUEM FALA (na PJ, o da pessoa autorizada, não o da
 * empresa). Devolve só sim ou não, e só para o dono do telefone: o CPF nunca
 * sai do banco, nem para o NM Connect. `security definer` porque o
 * `crm_leitor` não lê `escritorio.pessoas`. O limite de tentativas fica no
 * NM Connect, que conta por conversa (este banco é só leitura para ele).
 */
create or replace function ia.conferir_cpf(p_telefone text, p_digitos text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_digitos ~ '^[0-9]{3}$', false)
     and exists (
       select 1 from escritorio.pessoas pe
       where escritorio.telefone_canonico(pe.telefone_whatsapp) = escritorio.telefone_canonico(p_telefone)
         and pe.cpf_confere = p_digitos
     )
$$;

-- ===========================================================================
-- Papel de leitura do NM Connect
-- ===========================================================================

/*
 * Nasce SEM senha (não entra). A senha é definida à mão, fora do git:
 *   alter role crm_leitor password '...';
 * No Supabase, a conexão pelo pooler usa o usuário `crm_leitor.<ref-do-projeto>`.
 */
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crm_leitor') then
    create role crm_leitor login;
  end if;
end
$$;

alter role crm_leitor set default_transaction_read_only = on;
alter role crm_leitor set statement_timeout = '5s';

-- Funções nascem com EXECUTE para PUBLIC; no Supabase, anon e authenticated
-- podem ganhar por default privileges. Fecha tudo e abre só o necessário.
revoke all on schema escritorio from public;
revoke all on all tables in schema escritorio from public;
revoke execute on all functions in schema escritorio from public;
revoke all on schema ia from public;
revoke all on all tables in schema ia from public;
revoke execute on all functions in schema ia from public;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema escritorio, ia from %I', r);
      execute format('revoke all on all tables in schema escritorio, ia from %I', r);
      execute format('revoke execute on all functions in schema escritorio, ia from %I', r);
    end if;
  end loop;
end
$$;

/*
 * As views chamam as funções de telefone, e o Postgres confere EXECUTE de
 * função com o papel de quem consulta, não com o dono da view. São funções
 * puras (não leem tabela): o `usage` no schema não dá acesso a tabela nenhuma.
 */
grant usage on schema escritorio to crm_leitor;
grant execute on function escritorio.telefone_canonico(text), escritorio.variantes_do_telefone(text) to crm_leitor;

grant usage on schema ia to crm_leitor;
grant select on ia.processos, ia.andamentos to crm_leitor;
grant execute on function ia.conferir_cpf(text, text) to crm_leitor;
