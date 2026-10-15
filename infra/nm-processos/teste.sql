-- ---------------------------------------------------------------------------
-- Testes do banco de processos (infra/nm-processos/001_base.sql).
--
-- Roda dentro de uma transação que termina em ROLLBACK: nada fica no banco.
-- Cada bloco levanta exceção quando a regra quebra, e o `ON_ERROR_STOP` do
-- psql transforma isso em código de saída diferente de zero.
--
-- Uso: infra/nm-processos/testar.sh  (sobe um Postgres descartável)
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP 1
begin;

-- ── Massa de teste ─────────────────────────────────────────────────────────
-- Ana tem dois processos: um com andamento liberado (e um mais novo ainda em
-- revisão) e outro sem nada liberado. Bruno tem um processo próprio.
insert into escritorio.clientes (id, nome, telefone_whatsapp, cpf_confere) values
  ('00000000-0000-0000-0000-00000000000a', 'Ana Teste',   '+5511987654321', '472'),
  ('00000000-0000-0000-0000-00000000000b', 'Bruno Teste', '+5531988887777', '901');

insert into escritorio.processos (id, numero_cnj, apelido, area, fase, advogado_responsavel) values
  ('00000000-0000-0000-0000-0000000000a1', '0001234-56.2025.5.02.0001', 'Trabalhista contra Empresa X', 'Trabalhista', 'Aguardando sentença', 'Dr. Responsável'),
  ('00000000-0000-0000-0000-0000000000a2', '0007654-32.2026.8.26.0100', 'Revisional do financiamento', 'Cível', 'Inicial', 'Dra. Responsável'),
  ('00000000-0000-0000-0000-0000000000b1', '0009999-11.2026.8.13.0024', 'Ação do Bruno', 'Cível', 'Citação', 'Dr. Responsável');

insert into escritorio.cliente_processo (cliente_id, processo_id) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1');

insert into escritorio.andamentos
  (processo_id, data, texto_para_cliente, proximo_passo, liberado_para_cliente, revisado_por, revisado_em) values
  ('00000000-0000-0000-0000-0000000000a1', '2026-10-01', 'A audiência foi realizada.', 'Aguardar a decisão do juiz.', true, 'Dr. Responsável', now()),
  ('00000000-0000-0000-0000-0000000000a1', '2026-10-10', 'RASCUNHO NÃO REVISADO', null, false, null, null),
  ('00000000-0000-0000-0000-0000000000a2', '2026-10-05', 'RASCUNHO DO OUTRO PROCESSO', null, false, null, null),
  ('00000000-0000-0000-0000-0000000000b1', '2026-10-02', 'O réu foi citado.', null, true, 'Dr. Responsável', now());

-- ── 1. Regras de cadastro ──────────────────────────────────────────────────
do $$
begin
  begin
    insert into escritorio.clientes (nome, telefone_whatsapp, cpf_confere) values ('X', '11987654321', '123');
    raise exception 'FALHOU: telefone sem +DDI foi aceito';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.clientes (nome, telefone_whatsapp, cpf_confere) values ('X', null, '123');
    raise exception 'FALHOU: cliente sem telefone foi aceito';
  exception when not_null_violation then null;
  end;
  -- Um telefone, um cliente: com dois donos, o mesmo WhatsApp veria os
  -- processos dos dois. Vale também para a grafia sem o nono dígito.
  begin
    insert into escritorio.clientes (nome, telefone_whatsapp, cpf_confere) values ('X', '+5511987654321', '123');
    raise exception 'FALHOU: telefone repetido foi aceito';
  exception when unique_violation then null;
  end;
  begin
    insert into escritorio.clientes (nome, telefone_whatsapp, cpf_confere) values ('X', '+551187654321', '123');
    raise exception 'FALHOU: telefone repetido sem o nono dígito foi aceito';
  exception when unique_violation then null;
  end;
  begin
    insert into escritorio.clientes (nome, telefone_whatsapp, cpf_confere) values ('X', '+5511900000000', '12');
    raise exception 'FALHOU: cpf_confere com 2 dígitos foi aceito';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.clientes (nome, telefone_whatsapp, cpf_confere) values ('X', '+5511900000000', '12345678901');
    raise exception 'FALHOU: CPF inteiro foi aceito em cpf_confere';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.andamentos (processo_id, data, texto_para_cliente, liberado_para_cliente)
      values ('00000000-0000-0000-0000-0000000000a1', '2026-10-11', 'x', true);
    raise exception 'FALHOU: andamento liberado sem revisor foi aceito';
  exception when check_violation then null;
  end;
end $$;

-- ── 2. Texto editado depois de liberado volta para revisão ─────────────────
do $$
declare v_liberado boolean;
begin
  update escritorio.andamentos set texto_para_cliente = 'O réu foi citado e tem prazo.'
   where processo_id = '00000000-0000-0000-0000-0000000000b1';
  select liberado_para_cliente into v_liberado from escritorio.andamentos
   where processo_id = '00000000-0000-0000-0000-0000000000b1';
  if v_liberado then
    raise exception 'FALHOU: texto mudou e o andamento continuou liberado sem nova revisão';
  end if;
  -- Nova revisão no mesmo update libera de novo.
  update escritorio.andamentos
     set texto_para_cliente = 'O réu foi citado.', liberado_para_cliente = true,
         revisado_por = 'Dr. Responsável', revisado_em = now() + interval '1 second'
   where processo_id = '00000000-0000-0000-0000-0000000000b1';
  select liberado_para_cliente into v_liberado from escritorio.andamentos
   where processo_id = '00000000-0000-0000-0000-0000000000b1';
  if not v_liberado then
    raise exception 'FALHOU: revisão nova no mesmo update não liberou o andamento';
  end if;
end $$;

-- ── 3. Variantes do telefone (nono dígito) ─────────────────────────────────
do $$
begin
  if not ('+553188887777' = any (escritorio.variantes_do_telefone('+5531988887777'))) then
    raise exception 'FALHOU: variante sem o nono dígito ausente';
  end if;
  if not ('+5531988887777' = any (escritorio.variantes_do_telefone('+553188887777'))) then
    raise exception 'FALHOU: variante com o nono dígito ausente';
  end if;
  if cardinality(escritorio.variantes_do_telefone('+14155550123')) <> 1 then
    raise exception 'FALHOU: número estrangeiro ganhou variante';
  end if;
  -- Fixo brasileiro (começa com 2-5 depois do DDD) não ganha nono dígito.
  if cardinality(escritorio.variantes_do_telefone('+551133334444')) <> 1 then
    raise exception 'FALHOU: telefone fixo ganhou variante de celular';
  end if;
end $$;

-- ── 4. O que o leitor da IA enxerga ────────────────────────────────────────
set local role crm_leitor;

do $$
declare n int;
begin
  -- Tabelas reais: fora do alcance.
  begin
    perform 1 from escritorio.clientes limit 1;
    raise exception 'FALHOU: crm_leitor leu escritorio.clientes';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from escritorio.andamentos limit 1;
    raise exception 'FALHOU: crm_leitor leu escritorio.andamentos';
  exception when insufficient_privilege then null;
  end;

  -- O catálogo que o conector lista só mostra as views da IA.
  select count(*) into n from information_schema.tables
   where table_schema not in ('pg_catalog', 'information_schema')
     and table_schema <> 'ia';
  if n <> 0 then
    raise exception 'FALHOU: crm_leitor enxerga % objeto(s) fora do schema ia', n;
  end if;

  -- Nenhuma coluna de CPF nas views.
  select count(*) into n from information_schema.columns
   where table_schema = 'ia' and column_name ilike '%cpf%';
  if n <> 0 then
    raise exception 'FALHOU: view da IA expõe coluna de CPF';
  end if;

  -- Ana: dois processos, pelo telefone com ou sem o nono dígito.
  select count(distinct numero_cnj) into n from ia.processos where telefone = '+5511987654321';
  if n <> 2 then raise exception 'FALHOU: Ana deveria ver 2 processos, viu %', n; end if;
  select count(distinct numero_cnj) into n from ia.processos where telefone = '+551187654321';
  if n <> 2 then raise exception 'FALHOU: telefone sem o nono dígito não achou os processos da Ana'; end if;

  -- O último andamento mostrado é o LIBERADO, não o rascunho mais novo.
  perform 1 from ia.processos
   where telefone = '+5511987654321' and apelido = 'Trabalhista contra Empresa X'
     and ultimo_andamento = 'A audiência foi realizada.';
  if not found then raise exception 'FALHOU: último andamento não é o liberado'; end if;

  -- Processo sem nada liberado aparece, mas sem andamento.
  perform 1 from ia.processos
   where telefone = '+5511987654321' and apelido = 'Revisional do financiamento'
     and ultimo_andamento is null;
  if not found then raise exception 'FALHOU: processo sem andamento liberado sumiu ou mostrou rascunho'; end if;

  -- Histórico: só liberados.
  select count(*) into n from ia.andamentos where texto_para_cliente like 'RASCUNHO%';
  if n <> 0 then raise exception 'FALHOU: ia.andamentos mostrou rascunho'; end if;
  select count(distinct texto_para_cliente) into n from ia.andamentos where telefone = '+5511987654321';
  if n <> 1 then raise exception 'FALHOU: Ana deveria ver 1 andamento liberado, viu %', n; end if;

  -- Ana não vê o processo do Bruno.
  select count(*) into n from ia.processos where telefone = '+5511987654321' and apelido = 'Ação do Bruno';
  if n <> 0 then raise exception 'FALHOU: processo do Bruno apareceu para a Ana'; end if;

  -- Conferência do CPF: só sim ou não, e só para o dono do telefone.
  if not ia.conferir_cpf('+5511987654321', '472') then raise exception 'FALHOU: CPF certo não conferiu'; end if;
  if not ia.conferir_cpf('+551187654321', '472') then raise exception 'FALHOU: CPF certo sem o nono dígito não conferiu'; end if;
  if ia.conferir_cpf('+5511987654321', '473') then raise exception 'FALHOU: CPF errado conferiu'; end if;
  if ia.conferir_cpf('+5531988887777', '472') then raise exception 'FALHOU: CPF da Ana conferiu no telefone do Bruno'; end if;
  if ia.conferir_cpf('+5511900000000', '472') then raise exception 'FALHOU: telefone desconhecido conferiu'; end if;
  if ia.conferir_cpf('+5511987654321', '') then raise exception 'FALHOU: dígitos vazios conferiram'; end if;
  if ia.conferir_cpf('+5511987654321', null) then raise exception 'FALHOU: dígitos nulos conferiram'; end if;
end $$;

reset role;
\echo 'OK: todos os testes do banco de processos passaram'
rollback;
