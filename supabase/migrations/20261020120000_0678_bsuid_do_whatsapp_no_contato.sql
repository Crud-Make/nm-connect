-- manifest: **Usernames do WhatsApp no canal oficial (BSUID).** Colunas GERADAS `contacts.wa_bsuid` e `contacts.wa_username` (de `source_metadata.meta_bsuid`/`meta_username`, o desenho do `wa_lid`), índice único parcial por organização em `wa_bsuid`, RPC `fn_upsert_meta_contact` (acha a ficha pelo BSUID e depois pelo telefone; junta a ficha só-BSUID com a do telefone por `fn_mesclar_contatos`) e gatilho que entrega o BSUID ao vencedor de qualquer fusão. Nenhum dado existente reescrito.
--
-- 0678 · o contato que chega pelo BSUID.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
--
-- Quem adota username no WhatsApp pode chegar SEM telefone: a Meta omite
-- `messages[].from` quando a empresa não falou com aquele número nos últimos 30
-- dias e a pessoa não tem o número da empresa nos contatos — o lead novo de
-- anúncio ou Instagram. A identidade que sempre vem é o BSUID
-- (`from_user_id`, `US.13491208655302741918`). O parser descartava a mensagem
-- (`if (!id || !from) continue`): sem contato, sem conversa, sem lead, sem IA.
-- Fonte: developers.facebook.com/documentation/business-messaging/whatsapp/
-- business-scoped-user-ids (atualizada em 15/09/2026).
--
-- ─── Por que dentro de `source_metadata`, com coluna GERADA ─────────────────
--
-- É o desenho do `wa_lid` (0122), e por três razões que já valem lá:
--
--   1. LGPD sem tocar no expurgo: `fn_lgpd_cascade_redact_contact` zera
--      `source_metadata` (e tem OITO definições no baseline — uma nona seria a
--      próxima a divergir). Zerado o metadata, a coluna gerada zera junto: o
--      BSUID e o username somem na anonimização sem uma linha a mais.
--   2. O export do titular já lê `source_metadata` inteiro
--      (`lib/lgpd/export-collector.ts`): o BSUID e o username entram no
--      relatório do Art. 18 sem mudar o coletor.
--   3. Valor derivado que alguém precisa lembrar de atualizar diverge; gerado,
--      não.
--
-- `nullif(btrim(...), '')` no fim: contato sem BSUID não pode virar string
-- vazia, ou colidiria no índice único com todos os outros contatos sem BSUID.
--
-- ─── A HIPÓTESE da unicidade ────────────────────────────────────────────────
--
-- A doc diz que o BSUID é único por PORTFÓLIO + usuário. O índice o faz único
-- por ORGANIZAÇÃO — o que pressupõe uma organização com números de UM
-- portfólio. Com dois portfólios, a mesma pessoa tem dois BSUIDs; o segundo
-- não casa com o primeiro e a pessoa pode virar duas fichas. A falha possível é
-- DUPLICAR (que a junção manual conserta), nunca misturar duas pessoas.
--
-- ─── Por que um gatilho na fusão, e não mais uma cópia de `fn_mesclar_contatos` ─
--
-- A fusão herda `waha_lid` e `social_identity` do perdedor por código próprio
-- (0407), e a função já tem cinco definições no baseline. O gatilho faz o mesmo
-- para o BSUID em QUALQUER fusão — a da tela, a desta RPC, a dedup de um clone —
-- sem uma sexta. Sem ele, depois de juntar duas fichas a próxima mensagem pelo
-- BSUID não acharia ficha viva e criaria outra, refazendo a duplicata.
--
-- Idempotente: colunas `if not exists`, dedup que na segunda passada não acha
-- nada, índice `if not exists`, `create or replace`, gatilho com drop+create.

-- ---- 1 · as colunas, derivadas do metadata ----
alter table public.contacts
  add column if not exists wa_bsuid text
  generated always as (nullif(btrim(coalesce(source_metadata->>'meta_bsuid', '')), '')) stored;

alter table public.contacts
  add column if not exists wa_username text
  generated always as (nullif(btrim(coalesce(source_metadata->>'meta_username', '')), '')) stored;

comment on column public.contacts.wa_bsuid is
  'BSUID do WhatsApp (id do usuário no escopo do portfólio da Meta, ex.: US.13491208655302741918). GERADA de source_metadata.meta_bsuid: zera na anonimização junto com o metadata. Única por organização entre fichas vivas (hipótese: 1 portfólio por organização). Endereço de envio quando o contato não tem telefone. Migration 0678.';
comment on column public.contacts.wa_username is
  'Username do WhatsApp (contacts[].profile.username do webhook da Meta). GERADA de source_metadata.meta_username. Rótulo de tela do contato sem telefone. Migration 0678.';

-- ---- 2 · deduplicar ANTES do índice único (auto-curativo) ----
-- Em banco nenhum isto acha linha hoje: nenhum código gravou `meta_bsuid` antes
-- desta migration. Existe para o `update.sh` nunca quebrar no índice, se um
-- dia alguém gravar o metadata à mão. O sobrevivente é o mais ANTIGO, e a
-- junção é a da tela (`fn_mesclar_contatos`), que reponta tudo pelo catálogo.
do $dedup$
declare
  g record;
begin
  for g in
    select organization_id,
           (array_agg(id order by created_at, id))[1] as principal,
           (array_agg(id order by created_at, id))[2:] as secundarios
      from public.contacts
     where wa_bsuid is not null and is_merged_into is null and is_anonymized = false
     group by organization_id, wa_bsuid
    having count(*) > 1
  loop
    perform public.fn_mesclar_contatos(g.organization_id, g.principal, g.secundarios);
  end loop;
end
$dedup$;

create unique index if not exists uniq_contacts_org_wa_bsuid
  on public.contacts (organization_id, wa_bsuid)
  where wa_bsuid is not null and is_merged_into is null;

-- ---- 3 · a fusão entrega o BSUID ao vencedor ----
-- O vencedor só herda quando não tem BSUID próprio e nenhum TERCEIRO contato
-- vivo tem aquele — a mesma guarda de unicidade que a fusão aplica ao telefone
-- e ao lid. Com o username junto, quando o vencedor não tem um.
--
-- Sem `security definer`: o gatilho roda com os direitos de quem fundiu, e a
-- fusão da tela já é `security definer`. Nada aqui é alcançável pela REST.
create or replace function public.fn_contato_mesclado_entrega_o_bsuid()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.contacts p
     set source_metadata = p.source_metadata
           || jsonb_build_object('meta_bsuid', old.wa_bsuid)
           || case when p.wa_username is null and old.wa_username is not null
                   then jsonb_build_object('meta_username', old.wa_username)
                   else '{}'::jsonb end,
         updated_at = now()
   where p.id = new.is_merged_into
     and p.organization_id = new.organization_id
     and p.wa_bsuid is null
     and p.is_anonymized = false
     and not exists (
       select 1 from public.contacts o
        where o.organization_id = new.organization_id
          and o.is_merged_into is null
          and o.id <> p.id
          and o.wa_bsuid = old.wa_bsuid
     );
  return null;
end;
$$;

revoke execute on function public.fn_contato_mesclado_entrega_o_bsuid() from public, anon, authenticated;
grant  execute on function public.fn_contato_mesclado_entrega_o_bsuid() to service_role;

drop trigger if exists contacts_mesclado_entrega_o_bsuid on public.contacts;
create trigger contacts_mesclado_entrega_o_bsuid
  after update of is_merged_into on public.contacts
  for each row
  when (old.is_merged_into is null and new.is_merged_into is not null and old.wa_bsuid is not null)
  execute function public.fn_contato_mesclado_entrega_o_bsuid();

-- ---- 4 · o upsert do canal oficial: BSUID primeiro, telefone depois ----
--
-- A ordem é a regra. Quem chegou só pelo BSUID e depois mandou o telefone (no
-- webhook, ou tocando no botão REQUEST_CONTACT_INFO) JÁ tem ficha; procurar
-- primeiro pelo telefone criaria a segunda.
--
--   sem BSUID                        → `fn_upsert_wa_contact`, sem uma linha de diferença
--   BSUID novo, sem telefone         → ficha nova sem telefone, com o BSUID
--   BSUID novo, com telefone         → a ficha do telefone (existente ou nova,
--                                      pelo caminho de sempre) ganha o BSUID
--   BSUID conhecido, telefone novo   → a ficha do BSUID ganha o telefone
--   BSUID conhecido e o telefone tem OUTRA ficha:
--       ficha do BSUID sem telefone  → JUNTA as duas (`fn_mesclar_contatos`,
--                                      a mais antiga vence)
--       ficha do BSUID com OUTRO tel → não junta: `telefone_em_conflito`
--
-- Tudo que o telefone traz (o nono dígito, `waha_chat_id`, o nome do perfil)
-- continua passando por `fn_upsert_wa_contact`: uma regra de telefone só.
--
-- `p_username` SOBRESCREVE: o username é da pessoa, ela o troca, e o webhook
-- traz o vigente. O nome (`display_name`) segue "completar, nunca sobrescrever".
create or replace function public.fn_upsert_meta_contact(
  p_org uuid, p_bsuid text, p_username text, p_phone text, p_chat_id text, p_notify text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bsuid text := nullif(btrim(coalesce(p_bsuid, '')), '');
  v_username text := nullif(btrim(coalesce(p_username, '')), '');
  v_notify text := nullif(btrim(coalesce(p_notify, '')), '');
  v_variantes text[] := '{}'::text[];
  v_canonico text;
  v_por_bsuid public.contacts%rowtype;
  v_por_telefone public.contacts%rowtype;
  v_id uuid;
  v_principal uuid;
  v_secundario uuid;
begin
  if p_org is null then
    raise exception using errcode = '22023', message = 'organizacao_obrigatoria';
  end if;
  -- Fora do formato da doc vale como ausente (o TypeScript já filtra; isto é a
  -- mesma régua no banco, para o índice nunca guardar endereço que a API recusa).
  if v_bsuid is not null and v_bsuid !~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$' then
    v_bsuid := null;
  end if;

  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    -- As grafias com e sem o nono, pela regra ÚNICA do banco (`fn_telefone_variantes`).
    -- A canônica é a mais longa: o celular BR COM o nono, ou o próprio número.
    select coalesce(array_agg('+' || v), '{}'::text[]) into v_variantes
      from unnest(public.fn_telefone_variantes(p_phone)) as t(v);
    select '+' || v into v_canonico
      from unnest(public.fn_telefone_variantes(p_phone)) as t(v)
     order by length(v) desc, v
     limit 1;
    if v_canonico is null or v_canonico !~ '^\+\d{8,15}$' then
      v_canonico := null;
      v_variantes := '{}'::text[];
    end if;
  end if;

  -- Sem BSUID: o caminho de sempre.
  if v_bsuid is null then
    if v_canonico is null then
      raise exception using errcode = '22023', message = 'contato_sem_identidade';
    end if;
    return public.fn_upsert_wa_contact(p_org, 'phone', p_phone, null, p_chat_id, p_notify);
  end if;

  -- 1 · Quem já tem este BSUID. `for update`: duas mensagens da mesma pessoa
  --     chegando juntas não decidem a junção duas vezes.
  select * into v_por_bsuid from public.contacts
   where organization_id = p_org and wa_bsuid = v_bsuid and is_merged_into is null
   limit 1
   for update;

  -- 2 · Quem já tem este telefone, em qualquer grafia.
  if cardinality(v_variantes) > 0 then
    select * into v_por_telefone from public.contacts
     where organization_id = p_org and is_merged_into is null
       and phone_number = any(v_variantes)
     order by case when phone_number = v_canonico then 0 else 1 end, created_at, id
     limit 1;
  end if;

  if v_por_bsuid.id is null then
    if v_canonico is not null then
      -- A ficha do telefone, existente ou nova, pelo caminho de sempre.
      v_id := public.fn_upsert_wa_contact(p_org, 'phone', p_phone, null, p_chat_id, p_notify);
    else
      begin
        insert into public.contacts
          (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
        values
          (p_org, null, 'whatsapp', '{}'::jsonb, '{}'::text[],
           jsonb_strip_nulls(jsonb_build_object(
             'meta_bsuid', v_bsuid, 'meta_username', v_username, 'notify_name', v_notify)),
           v_notify)
        returning id into v_id;
        return v_id;
      exception when unique_violation then
        -- Outra entrega da mesma pessoa chegou primeiro ao índice: é a ficha dela.
        select id into v_id from public.contacts
         where organization_id = p_org and wa_bsuid = v_bsuid and is_merged_into is null
         limit 1;
      end;
    end if;
  else
    v_id := v_por_bsuid.id;
    if v_canonico is not null then
      if v_por_telefone.id is not null and v_por_telefone.id <> v_por_bsuid.id then
        if v_por_bsuid.phone_number is null then
          -- O mesmo cliente em duas fichas: a do BSUID (sem telefone) e a do
          -- telefone. Junta — a mais antiga vence, como em toda dedup deste banco.
          if (v_por_telefone.created_at, v_por_telefone.id) <= (v_por_bsuid.created_at, v_por_bsuid.id) then
            v_principal := v_por_telefone.id;
            v_secundario := v_por_bsuid.id;
          else
            v_principal := v_por_bsuid.id;
            v_secundario := v_por_telefone.id;
          end if;
          begin
            perform public.fn_mesclar_contatos(p_org, v_principal, array[v_secundario]);
            v_id := v_principal;
          exception when others then
            -- A junção não pode derrubar a mensagem: sem ela a pessoa segue na
            -- ficha do BSUID, e o conflito fica escrito para a junção manual.
            raise warning 'fn_upsert_meta_contact: junção recusada (%): %', sqlstate, sqlerrm;
            update public.contacts
               set source_metadata = source_metadata || jsonb_build_object('telefone_em_conflito', v_canonico),
                   updated_at = now()
             where id = v_por_bsuid.id;
            v_canonico := null;
          end;
        else
          -- A ficha do BSUID já tem OUTRO telefone: não mistura duas pessoas.
          update public.contacts
             set source_metadata = source_metadata || jsonb_build_object('telefone_em_conflito', v_canonico),
                 updated_at = now()
           where id = v_por_bsuid.id;
          v_canonico := null;
        end if;
      elsif v_por_telefone.id is null then
        if v_por_bsuid.phone_number is null then
          -- O telefone apareceu e ninguém mais o tem: entra na ficha do BSUID.
          update public.contacts set phone_number = v_canonico, updated_at = now()
           where id = v_por_bsuid.id;
        else
          update public.contacts
             set source_metadata = source_metadata || jsonb_build_object('telefone_em_conflito', v_canonico),
                 updated_at = now()
           where id = v_por_bsuid.id;
          v_canonico := null;
        end if;
      end if;

      if v_canonico is not null then
        -- O resto do que o telefone traz, pela régua de sempre — agora ela
        -- reencontra a ficha certa pelo telefone.
        v_id := public.fn_upsert_wa_contact(p_org, 'phone', v_canonico, null, p_chat_id, p_notify);
      end if;
    end if;
  end if;

  -- 3 · O BSUID e o username na ficha que ficou. Ficha com OUTRO BSUID não é
  --     sobrescrita (dois portfólios — ver o cabeçalho): o recebido fica em
  --     `bsuid_em_conflito`, e o username só entra quando o BSUID é o dela.
  begin
    update public.contacts c set
      source_metadata = c.source_metadata
        || case
             when c.wa_bsuid is null then jsonb_build_object('meta_bsuid', v_bsuid)
             when c.wa_bsuid = v_bsuid then '{}'::jsonb
             else jsonb_build_object('bsuid_em_conflito', v_bsuid)
           end
        || case
             when v_username is not null and (c.wa_bsuid is null or c.wa_bsuid = v_bsuid)
               then jsonb_build_object('meta_username', v_username)
             else '{}'::jsonb
           end
        || case when v_notify is not null then jsonb_build_object('notify_name', v_notify) else '{}'::jsonb end,
      display_name = coalesce(c.display_name, v_notify),
      updated_at = now()
    where c.id = v_id and c.organization_id = p_org;
  exception when unique_violation then
    -- Corrida rara: outra ficha ganhou este BSUID entre a busca e aqui. A
    -- mensagem entra nesta ficha; o BSUID fica com a outra.
    update public.contacts c set
      display_name = coalesce(c.display_name, v_notify),
      updated_at = now()
    where c.id = v_id and c.organization_id = p_org;
  end;

  return v_id;
end;
$$;

-- Função nova em `public` nasce alcançável pelas DUAS origens (o grant a PUBLIC
-- e o default privilege do baseline para `anon`): as duas saem, e só o backend
-- (admin client do webhook) entra.
revoke all on function public.fn_upsert_meta_contact(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_upsert_meta_contact(uuid, text, text, text, text, text) to service_role;
