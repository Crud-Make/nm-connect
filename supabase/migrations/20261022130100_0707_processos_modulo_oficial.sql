-- manifest: **Módulo Processos (advocacia), PR 1: banco, registro e trava.** Provisionadora `fn_processos_provisionar()` (ADR-0002 D2/D4/D5: sem parâmetro, `security definer`, EXECUTE só de `service_role`, termina em `fn_proteger_modulo_provisionado()`) com duas tabelas que só nascem quando o módulo é instalado: `processos` (contato por FK composta com a organização, número CNJ com CHECK de formato e único por organização, apelido, área e fase por CHECK, advogado responsável) e `andamentos` (o texto que vai PARA O CLIENTE, rascunho/aprovado, com CHECK de coerência que amarra o aprovado ao sha256 do texto — reescrever o aprovado sem refazer o hash falha no banco). RLS por operação (processos: leitura viewer+, escrita agent+, apagar manager+; andamentos: o aprovado para viewer+, rascunho só agent+, e a sessão só escreve rascunho). RPCs fora do corpo, que compilam sem as tabelas (D7): `fn_processos_andamento_aprovar` (manager+, `for update`) e `fn_processos_andamento_editar` (agent+, volta a rascunho). Seções de LGPD declaradas em `modulo_secoes_lgpd` (D8). Nenhuma tabela nasce nesta migration.
--
-- 0707 — Processos: o segundo módulo de advocacia sobre o mecanismo da ADR-0002.
--
-- Lei: docs/adr/0002-tabelas-de-modulo-num-banco-so.md. Molde: honorários (0480) para a RLS
-- por operação e a RPC com `for update`; financeiro (0619) para a seção de LGPD declarada por
-- rotina própria chamada no corpo.
--
-- ── Destino (DoD 18): extensão ────────────────────────────────────────────────────────────────
-- Processo judicial e andamento são jornada de advocacia: sem eles, funil, inbox e agenda do
-- núcleo continuam inteiros. A trava do CPF pelo cadastro, que o módulo vai usar (PR 3), é
-- núcleo e saiu na 0706. Nesta PR não há rota, tela nem ferramenta da IA (PR 2 e PR 3).
--
-- ── D2/D3: a migration cria a FUNÇÃO, nunca a tabela ─────────────────────────────────────────
-- As tabelas só existem onde um administrador da instalação chama
-- `fn_modulo_instalar('processos', …)`. Quem nunca instala não carrega nada.
--
-- ── O modelo ──────────────────────────────────────────────────────────────────────────────────
-- * `processos.contact_id` é FK COMPOSTA `(organization_id, contact_id) → contacts
--   (organization_id, id)` pelo `uq_contacts_org_id`: a checagem de FK não passa por RLS, e uma FK
--   só para `contacts(id)` aceitaria o contato de outra organização (o módulo viraria ponte entre
--   tenants). Sem `on delete`: NO ACTION, de propósito — apagar a ficha do cliente não pode levar o
--   processo junto (anti-pattern 7, cascade fantasma). A exclusão de contato responde 409 pelo
--   caminho de FK que a rota já trata; o caminho da pessoa é a anonimização (abaixo). Apagar a
--   ORGANIZAÇÃO segue funcionando: NO ACTION confere no fim do comando, depois das cascatas.
-- * A JUNÇÃO de contatos duplicados reponta este FK sem nada novo: `fn_mesclar_contatos` varre
--   `pg_constraint` em tempo de execução e, desde a 0611, alcança FK composta pela posição de
--   `contacts.id` — a tabela provisionada depois entra no laço sozinha (provado no invariante).
-- * `numero_cnj` é NULÁVEL: processo ainda não distribuído não tem número, e a anonimização o
--   apaga (o número leva à pessoa em qualquer consulta pública de tribunal). Único por organização.
-- * `advogado_user_id` segue `crm_leads.owner_user_id`: `auth.users(id) on delete set null`.
-- * Andamento: `aprovado ⇒ aprovado_em e hash = sha256(texto)`, e `rascunho ⇒ nenhum campo de
--   aprovação`. `aprovado_por` NÃO entra no CHECK — é `on delete set null` como todo FK para login
--   desta casa, e exigi-lo faria apagar um login recusar (a mesma coerência de uma via só da
--   carteira do cliente, 0622). Quem aprovou fica gravado pela RPC, que sempre o preenche.
-- * O único escape do hash é o da LGPD: `texto = '[redigido]'` com hash nulo. A sessão não chega
--   lá (só escreve rascunho); quem chega é a seção declarada, na anonimização do contato.
--
-- ── D4: por que a provisionadora não é porta de adulteração ──────────────────────────────────
-- Sem parâmetro, idempotente (`if not exists`, `drop … if exists` + `create`), EXECUTE só de
-- `service_role` com revoke das DUAS origens (o grant a PUBLIC da criação e o direto a `anon` do
-- default ACL do baseline). O corpo só escreve nas tabelas dele; a única escrita fora — a linha de
-- `modulo_secoes_lgpd` — mora em `fn_processos_declarar_secoes_lgpd`, como na 0619.
--
-- ── D5: RLS POR OPERAÇÃO, ligada aqui ────────────────────────────────────────────────────────
-- `fn_proteger_modulo_provisionado()` só põe a policy ampla em tabela de RLS DESLIGADA. Aqui a
-- RLS é por papel e por estado, então a função a liga ela mesma e chama a rotina no fim só para
-- as travas do suporte. Escrita aceita `fn_is_platform_admin_full()`, nunca a função pura (0533:
-- `support_readonly` não escreve); leitura aceita a pura.
--
-- ── D7: as RPCs compilam sem as tabelas ───────────────────────────────────────────────────────
-- PL/pgSQL com `record`, nunca `%rowtype`. Aprovar e editar o aprovado são as únicas portas que a
-- RLS não abre, por isso `security definer`; as duas exigem `auth.uid()` (aprovar é ato de uma
-- pessoa) e o papel na organização do argumento por `fn_role_at_least`.
--
-- No `baseline.sql` tudo isto entra ANTES da VARREDURA anon (cria função).

create or replace function public.fn_processos_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create table if not exists public.processos (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    contact_id uuid not null,
    numero_cnj text,
    apelido text not null check (char_length(btrim(apelido)) between 1 and 120),
    -- `text` + CHECK, não enum (doutrina: enum é difícil de estender).
    area text not null check (area in ('civel', 'trabalhista', 'familia', 'previdenciario', 'criminal', 'tributario', 'outra')),
    fase text not null default 'conhecimento' check (fase in ('conhecimento', 'recurso', 'execucao', 'arquivado')),
    advogado_user_id uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- NNNNNNN-DD.AAAA.J.TR.OOOO (Resolução CNJ 65/2008): a forma, não o dígito verificador.
    constraint processos_numero_cnj_formato check (
      numero_cnj is null or numero_cnj ~ '^[0-9]{7}-[0-9]{2}\.[0-9]{4}\.[0-9]\.[0-9]{2}\.[0-9]{4}$'
    ),
    constraint processos_numero_unico unique (organization_id, numero_cnj),
    -- O alvo da FK composta de `andamentos`.
    constraint processos_org_id_unico unique (organization_id, id),
    constraint processos_contato_fkey foreign key (organization_id, contact_id)
      references public.contacts (organization_id, id)
  );

  create index if not exists processos_org_contato_idx
    on public.processos (organization_id, contact_id);

  create table if not exists public.andamentos (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    processo_id uuid not null,
    -- O texto PARA O CLIENTE: é o que a IA vai contar a ele, palavra por palavra.
    texto text not null constraint andamentos_texto_check check (char_length(btrim(texto)) between 1 and 2000),
    status text not null default 'rascunho' check (status in ('rascunho', 'aprovado')),
    criado_por uuid references auth.users(id) on delete set null,
    aprovado_por uuid references auth.users(id) on delete set null,
    aprovado_em timestamptz,
    hash_aprovado text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Andamento não existe fora do processo: apagar o processo (manager+) leva os andamentos.
    constraint andamentos_processo_fkey foreign key (organization_id, processo_id)
      references public.processos (organization_id, id) on delete cascade,

    -- A INVALIDAÇÃO POR CONSTRUÇÃO: mudar o texto de um aprovado sem refazer o hash falha aqui,
    -- para qualquer papel, inclusive o dono do banco. O escape é só o da anonimização (cabeçalho).
    constraint andamentos_aprovacao_coerente check (
      (status = 'rascunho' and aprovado_por is null and aprovado_em is null and hash_aprovado is null)
      or (status = 'aprovado' and aprovado_em is not null and (
            hash_aprovado = encode(sha256(convert_to(texto, 'UTF8')), 'hex')
            or (texto = '[redigido]' and hash_aprovado is null)))
    )
  );

  create index if not exists andamentos_org_processo_idx
    on public.andamentos (organization_id, processo_id, created_at desc);

  drop trigger if exists processos_updated_at on public.processos;
  create trigger processos_updated_at before update on public.processos
    for each row execute function public.fn_set_updated_at();
  drop trigger if exists andamentos_updated_at on public.andamentos;
  create trigger andamentos_updated_at before update on public.andamentos
    for each row execute function public.fn_set_updated_at();

  -- ── RLS POR OPERAÇÃO (D5, ligada aqui e não pela rotina automática) ────────
  -- `create policy X` e `on public.Y` em linhas separadas: a conferência do update.sh antigo lê o
  -- baseline linha a linha e cobraria a regra onde o módulo não está instalado (#1906).
  alter table public.processos enable row level security;
  drop policy if exists tenant_isolation_processos_all on public.processos;

  drop policy if exists processos_select on public.processos;
  create policy processos_select
    on public.processos
    for select using (
      organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
    );

  drop policy if exists processos_insert on public.processos;
  create policy processos_insert
    on public.processos
    for insert
    with check (public.fn_is_platform_admin_full()
                or (organization_id in (select public.fn_user_org_ids())
                    and public.fn_role_at_least(organization_id, 'agent')));

  drop policy if exists processos_update on public.processos;
  create policy processos_update
    on public.processos
    for update
    using (public.fn_is_platform_admin_full()
           or (organization_id in (select public.fn_user_org_ids())
               and public.fn_role_at_least(organization_id, 'agent')))
    with check (public.fn_is_platform_admin_full()
                or (organization_id in (select public.fn_user_org_ids())
                    and public.fn_role_at_least(organization_id, 'agent')));

  drop policy if exists processos_delete on public.processos;
  create policy processos_delete
    on public.processos
    for delete
    using (public.fn_is_platform_admin_full()
           or (organization_id in (select public.fn_user_org_ids())
               and public.fn_role_at_least(organization_id, 'manager')));
  revoke all on public.processos from anon;

  -- O aprovado é o que o cliente vai ouvir, e é o que o `viewer` lê. O rascunho é trabalho da
  -- equipe (agent+). A sessão só escreve rascunho: aprovar, e editar o aprovado, são das RPCs.
  alter table public.andamentos enable row level security;
  drop policy if exists tenant_isolation_andamentos_all on public.andamentos;

  drop policy if exists andamentos_select on public.andamentos;
  create policy andamentos_select
    on public.andamentos
    for select using (
      (organization_id in (select public.fn_user_org_ids())
       and (status = 'aprovado' or public.fn_role_at_least(organization_id, 'agent')))
      or public.fn_is_platform_admin()
    );

  drop policy if exists andamentos_insert on public.andamentos;
  create policy andamentos_insert
    on public.andamentos
    for insert
    with check ((public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'agent')))
                and status = 'rascunho');

  drop policy if exists andamentos_update on public.andamentos;
  create policy andamentos_update
    on public.andamentos
    for update
    using ((public.fn_is_platform_admin_full()
            or (organization_id in (select public.fn_user_org_ids())
                and public.fn_role_at_least(organization_id, 'agent')))
           and status = 'rascunho')
    with check ((public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'agent')))
                and status = 'rascunho');

  drop policy if exists andamentos_delete on public.andamentos;
  create policy andamentos_delete
    on public.andamentos
    for delete
    using ((public.fn_is_platform_admin_full()
            or (organization_id in (select public.fn_user_org_ids())
                and public.fn_role_at_least(organization_id, 'agent')))
           and status = 'rascunho');
  revoke all on public.andamentos from anon;

  comment on table public.processos is
    'Processo judicial do cliente (módulo processos, migration 0707). Contato por FK composta com a organização; número CNJ nulo até a distribuição ou depois da anonimização.';
  comment on table public.andamentos is
    'O que aconteceu no processo, no texto que vai PARA O CLIENTE. Aprovado = hash_aprovado é o sha256 do texto (CHECK); aprovar e editar o aprovado só pelas RPCs fn_processos_andamento_*.';

  -- D8: a anonimização alcança as duas tabelas pela seção declarada (0485).
  perform public.fn_processos_declarar_secoes_lgpd();

  -- RLS já ligada por nós, então esta rotina não mexe mais nelas (D5) — só
  -- aplica as travas de suporte, que dependem de RLS já estar de pé.
  perform public.fn_proteger_modulo_provisionado();
end;
$f$;

revoke execute on function public.fn_processos_provisionar() from public, anon, authenticated;
grant execute on function public.fn_processos_provisionar() to service_role;

-- ---- a seção de LGPD do módulo (D8) ----
--
-- Texto sobre a pessoa: o apelido do processo ("Divórcio da Maria") e o texto do andamento viram
-- `[redigido]` onde havia texto; o número CNJ e o hash do aprovado viram nulo (o número leva à
-- pessoa por consulta pública; o hash é impressão digital do texto que saiu). Área, fase, datas e
-- o vínculo ficam: operação do escritório, não dado da pessoa. Export e cópia ao titular: PR 3.
--
-- Rotina própria, e não `insert` no corpo da provisionadora, porque o molde reprova corpo de
-- módulo que escreve em tabela do núcleo (0619). Chamada só pela provisionadora: as tabelas
-- deste módulo nunca existiram antes dela, então não há a "porta A" da 0619. `do update` para a
-- declaração convergir quando o kit reaplica.
create or replace function public.fn_processos_declarar_secoes_lgpd()
returns void language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  insert into public.modulo_secoes_lgpd
      (modulo, tabela, ligacao, colunas, colunas_rotulo, colunas_redigidas, colunas_agora)
    values
      ('processos', 'processos',
       'organization_id = $1 and contact_id = $2',
       array['numero_cnj'], '{}'::text[], array['apelido'], '{}'::text[]),
      ('processos', 'andamentos',
       'organization_id = $1 and processo_id in (select p.id from public.processos p where p.organization_id = $1 and p.contact_id = $2)',
       array['hash_aprovado'], '{}'::text[], array['texto'], '{}'::text[])
    on conflict (modulo, tabela) do update
      set ligacao = excluded.ligacao,
          colunas = excluded.colunas,
          colunas_rotulo = excluded.colunas_rotulo,
          colunas_redigidas = excluded.colunas_redigidas,
          colunas_agora = excluded.colunas_agora;
end $f$;

revoke execute on function public.fn_processos_declarar_secoes_lgpd() from public, anon, authenticated;
grant execute on function public.fn_processos_declarar_secoes_lgpd() to service_role;

-- ---- fn_processos_andamento_aprovar: a única porta de aprovar ----
--
-- `for update` torna a transição rascunho→aprovado atômica: dois cliques leem a mesma linha em
-- fila, e o segundo encontra `aprovado` e é recusado, sem regravar quem aprovou nem quando. O hash
-- é calculado AQUI, do texto que está na linha travada — nunca vem de quem chama.
create or replace function public.fn_processos_andamento_aprovar(p_org uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_andamento record;
  v_resultado jsonb;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception 'processos_forbidden' using errcode = '42501';
  end if;

  select id, status into v_andamento from public.andamentos
   where id = p_id and organization_id = p_org
   for update;

  if not found then
    raise exception 'andamento_nao_encontrado' using errcode = 'P0002';
  end if;
  if v_andamento.status = 'aprovado' then
    raise exception 'andamento_ja_aprovado' using errcode = '22023';
  end if;

  update public.andamentos a
     set status = 'aprovado',
         aprovado_por = auth.uid(),
         aprovado_em = now(),
         hash_aprovado = encode(sha256(convert_to(a.texto, 'UTF8')), 'hex')
   where a.id = p_id
  returning to_jsonb(a) into v_resultado;

  return v_resultado;
end;
$$;

revoke execute on function public.fn_processos_andamento_aprovar(uuid, uuid) from public, anon;
grant execute on function public.fn_processos_andamento_aprovar(uuid, uuid) to authenticated;

-- ---- fn_processos_andamento_editar: o texto novo volta a rascunho ----
--
-- Editar um aprovado é o caminho que a RLS fecha para a sessão. Aqui o texto muda e a aprovação
-- some na MESMA escrita — o CHECK de coerência não deixaria outro desfecho, e quem aprovou o
-- texto antigo não aprovou o novo.
create or replace function public.fn_processos_andamento_editar(p_org uuid, p_id uuid, p_texto text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resultado jsonb;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'agent') then
    raise exception 'processos_forbidden' using errcode = '42501';
  end if;

  update public.andamentos a
     set texto = p_texto,
         status = 'rascunho',
         aprovado_por = null,
         aprovado_em = null,
         hash_aprovado = null
   where a.id = p_id and a.organization_id = p_org
  returning to_jsonb(a) into v_resultado;

  if v_resultado is null then
    raise exception 'andamento_nao_encontrado' using errcode = 'P0002';
  end if;

  return v_resultado;
end;
$$;

revoke execute on function public.fn_processos_andamento_editar(uuid, uuid, text) from public, anon;
grant execute on function public.fn_processos_andamento_editar(uuid, uuid, text) to authenticated;
