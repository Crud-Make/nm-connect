-- manifest: **A trava do CPF passa a conferir também pelo cadastro do contato (base do módulo Processos).** `verificacoes_de_identidade.connection_id` aceita NULL — NULL é a conferência feita contra o CPF do próprio cadastro, sem banco externo — e a unicidade vira `unique nulls not distinct (organization_id, contact_id, connection_id)`, para continuar valendo UMA linha por contato também quando a conexão é nula. Função nova `fn_conferir_cpf_do_contato(org, contato, dígitos) returns boolean`: decifra `contacts.cpf_encrypted` dentro do banco e compara só os 3 últimos dígitos; devolve NULL quando o contato não tem CPF; nunca devolve o CPF; EXECUTE só de `service_role`. Nenhuma linha existente muda e a trava do banco externo segue igual.
--
-- 0706 · a trava do CPF pelo cadastro do contato.
--
-- ─── Por que é núcleo, e não do módulo ──────────────────────────────────────
--
-- A trava existe sem o módulo de processos: é a mesma régua da 0676 (o
-- telefone do WhatsApp sozinho não prova quem fala), só que conferida contra o
-- CPF que a própria organização cadastrou no contato. O módulo de processos é
-- o primeiro consumidor (PR 3, ferramenta da IA); a função e a coluna nula
-- valem para qualquer consulta que precise da conferência sem banco externo.
--
-- ─── Por que NULL na conexão, e não uma coluna `fonte` ──────────────────────
--
-- "Conferido contra o cadastro" é exatamente "conferido sem conexão". Uma
-- coluna nova repetiria o que a nulidade já diz e abriria a combinação
-- incoerente (`fonte = 'cadastro'` com conexão preenchida). O estado continua
-- por (organização, contato, conexão): o contato conferido num banco externo
-- não fica conferido no cadastro, nem o contrário — cada fonte prova por si.
--
-- ─── Por que `nulls not distinct` (Postgres 15+) ────────────────────────────
--
-- Com a unicidade padrão, duas linhas com `connection_id` nulo para o mesmo
-- contato seriam DISTINTAS, e o `upsert` de `gravarConferencia` criaria uma
-- linha nova a cada tentativa — a contagem de erros nunca chegaria a 3 e o
-- bloqueio contra força bruta não existiria. Para as linhas com conexão nada
-- muda: valores não nulos já eram comparados igual. Nenhuma linha existente
-- tem conexão nula (a coluna era NOT NULL), então não há o que deduplicar
-- antes de recriar a constraint. O piso do produto é o 15
-- (`tests/unit/baseline-no-piso-do-postgres.test.ts`).
--
-- ─── A função: só `boolean`, só o servidor ──────────────────────────────────
--
-- `decrypt_cpf` não serve aqui e não é reutilizada: ela DEVOLVE o CPF, exige
-- sessão `manager`+ e audita a leitura do texto. O agente roda com a service
-- key (sem `auth.uid()`), e o modelo nunca pode ver o CPF. Esta compara dentro
-- do banco e devolve só se os 3 últimos dígitos conferem — o CPF não sai da
-- função. As guardas antes da decifra são as mesmas da 0240/0597 e na mesma
-- ordem (nulo, piso de 66 bytes, cara de pacote PGP): cifra nova, guarda nova
-- (`tests/unit/credencial-de-enfeite-nao-derruba-a-leitura.test.ts`).
-- `stable` porque não escreve; sem audit porque nenhum texto sai (a tentativa
-- fica em `verificacoes_de_identidade`, gravada por quem chama).
--
-- EXECUTE só de `service_role`, revogado das TRÊS origens que alcançariam o
-- PostgREST: o grant a PUBLIC da criação, o direto a `anon` do default ACL do
-- baseline, e `authenticated` — um usuário logado com a função na mão tentaria
-- os 1.000 finais de CPF de qualquer contato da própria organização.
--
-- Idempotente: `drop not null` e `drop/add constraint` reaplicam sem erro,
-- `create or replace function`, grants refeitos. No `baseline.sql` a função
-- entra ANTES da VARREDURA anon (cria função) e o `alter table` entra DEPOIS do
-- bloco da 0676, que é quem cria a tabela.

alter table public.verificacoes_de_identidade
  alter column connection_id drop not null;

alter table public.verificacoes_de_identidade
  drop constraint if exists verificacoes_de_identidade_unica;
alter table public.verificacoes_de_identidade
  add constraint verificacoes_de_identidade_unica
    unique nulls not distinct (organization_id, contact_id, connection_id);

comment on column public.verificacoes_de_identidade.connection_id is
  'O banco externo em que a conferência foi feita. NULL = conferência contra o CPF do cadastro do contato (fn_conferir_cpf_do_contato). Única por (organização, contato, conexão) com nulls not distinct.';

create or replace function public.fn_conferir_cpf_do_contato(
  p_org uuid,
  p_contato uuid,
  p_digitos text
) returns boolean
    language plpgsql stable security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  v_cipher bytea;
begin
  select cpf_encrypted into v_cipher
    from public.contacts
   where id = p_contato
     and organization_id = p_org;

  if v_cipher is null then return null; end if;
  if octet_length(v_cipher) < 66 then
    raise exception 'cpf_ciphertext_invalido';
  end if;
  if get_byte(v_cipher, 0) < 128 then
    raise exception 'cpf_ciphertext_invalido';
  end if;

  if p_digitos is null or p_digitos !~ '^[0-9]{3}$' then
    return false;
  end if;

  return right(regexp_replace(pgp_sym_decrypt(v_cipher, private.fn_cpf_key()), '[^0-9]', '', 'g'), 3) = p_digitos;
end$$;

revoke execute on function public.fn_conferir_cpf_do_contato(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.fn_conferir_cpf_do_contato(uuid, uuid, text) to service_role;

comment on function public.fn_conferir_cpf_do_contato(uuid, uuid, text) is
  'A trava do CPF pelo cadastro (0706): os 3 últimos dígitos conferem com contacts.cpf_encrypted? NULL = o contato não tem CPF. Nunca devolve o CPF. Só service_role.';
