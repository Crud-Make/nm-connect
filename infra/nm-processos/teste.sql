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
-- Pessoas são quem fala no WhatsApp. Clientes são PF ou PJ.
--   Ana    titular da PF "Ana Teste" (dois processos).
--   Bruno  titular da PF "Bruno Teste" (um processo).
--   Carla  sócia da PJ "Empresa XYZ" (um processo da empresa).
--   Davi   contador da Empresa XYZ.
insert into escritorio.pessoas (id, nome, telefone_whatsapp, cpf_confere) values
  ('00000000-0000-0000-0000-0000000000f1', 'Ana Teste',   '+5511987654321', '472'),
  ('00000000-0000-0000-0000-0000000000f2', 'Bruno Teste', '+5531988887777', '901'),
  ('00000000-0000-0000-0000-0000000000f3', 'Carla Sócia', '+5521977776666', '345'),
  ('00000000-0000-0000-0000-0000000000f4', 'Davi Contador', '+5521966665555', '678');

insert into escritorio.clientes (id, tipo, nome, cnpj) values
  ('00000000-0000-0000-0000-00000000000a', 'PF', 'Ana Teste',   null),
  ('00000000-0000-0000-0000-00000000000b', 'PF', 'Bruno Teste', null),
  ('00000000-0000-0000-0000-00000000000c', 'PJ', 'Empresa XYZ Ltda', '12345678000199');

insert into escritorio.cliente_pessoas (cliente_id, pessoa_id, papel) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1', 'titular'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000f2', 'titular'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000f3', 'socio'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000f4', 'contador');

insert into escritorio.processos (id, numero_cnj, apelido, area, fase, advogado_responsavel) values
  ('00000000-0000-0000-0000-0000000000a1', '0001234-56.2025.5.02.0001', 'Aposentadoria por idade', 'Previdenciário', 'Aguardando perícia', 'Dr. Responsável'),
  ('00000000-0000-0000-0000-0000000000a2', '0007654-32.2026.8.26.0100', 'Revisão do benefício', 'Previdenciário', 'Inicial', 'Dra. Responsável'),
  ('00000000-0000-0000-0000-0000000000b1', '0009999-11.2026.8.13.0024', 'Ação do Bruno', 'Cível', 'Citação', 'Dr. Responsável'),
  ('00000000-0000-0000-0000-0000000000c1', '0005555-22.2026.4.02.5101', 'Execução fiscal da XYZ', 'Tributário', 'Embargos', 'Dr. Tributário');

insert into escritorio.cliente_processo (cliente_id, processo_id) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000c1');

insert into escritorio.andamentos
  (processo_id, data, texto_para_cliente, proximo_passo, liberado_para_cliente, revisado_por, revisado_em) values
  ('00000000-0000-0000-0000-0000000000a1', '2026-10-01', 'A perícia foi marcada.', 'Comparecer à perícia.', true, 'Dr. Responsável', now()),
  ('00000000-0000-0000-0000-0000000000a1', '2026-10-10', 'RASCUNHO NÃO REVISADO', null, false, null, null),
  ('00000000-0000-0000-0000-0000000000a2', '2026-10-05', 'RASCUNHO DO OUTRO PROCESSO', null, false, null, null),
  ('00000000-0000-0000-0000-0000000000b1', '2026-10-02', 'O réu foi citado.', null, true, 'Dr. Responsável', now()),
  ('00000000-0000-0000-0000-0000000000c1', '2026-10-03', 'Os embargos foram protocolados.', null, true, 'Dr. Tributário', now());

-- ── 1. Regras de cadastro ──────────────────────────────────────────────────
do $$
begin
  begin
    insert into escritorio.pessoas (nome, telefone_whatsapp, cpf_confere) values ('X', '11987654321', '123');
    raise exception 'FALHOU: telefone sem +DDI foi aceito';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.pessoas (nome, telefone_whatsapp, cpf_confere) values ('X', null, '123');
    raise exception 'FALHOU: pessoa sem telefone foi aceita';
  exception when not_null_violation then null;
  end;
  -- Um telefone, uma pessoa: com dois donos, o mesmo WhatsApp veria os
  -- processos dos dois. Vale também para a grafia sem o nono dígito.
  begin
    insert into escritorio.pessoas (nome, telefone_whatsapp, cpf_confere) values ('X', '+5511987654321', '123');
    raise exception 'FALHOU: telefone repetido foi aceito';
  exception when unique_violation then null;
  end;
  begin
    insert into escritorio.pessoas (nome, telefone_whatsapp, cpf_confere) values ('X', '+551187654321', '123');
    raise exception 'FALHOU: telefone repetido sem o nono dígito foi aceito';
  exception when unique_violation then null;
  end;
  begin
    insert into escritorio.pessoas (nome, telefone_whatsapp, cpf_confere) values ('X', '+5511900000000', '12');
    raise exception 'FALHOU: cpf_confere com 2 dígitos foi aceito';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.pessoas (nome, telefone_whatsapp, cpf_confere) values ('X', '+5511900000000', '12345678901');
    raise exception 'FALHOU: CPF inteiro foi aceito em cpf_confere';
  exception when check_violation then null;
  end;
  -- PF não tem CNPJ; PJ precisa de CNPJ com 14 dígitos.
  begin
    insert into escritorio.clientes (tipo, nome, cnpj) values ('PJ', 'Sem CNPJ', null);
    raise exception 'FALHOU: PJ sem CNPJ foi aceita';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.clientes (tipo, nome, cnpj) values ('PF', 'Com CNPJ', '12345678000199');
    raise exception 'FALHOU: PF com CNPJ foi aceita';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.clientes (tipo, nome, cnpj) values ('PJ', 'CNPJ curto', '1234');
    raise exception 'FALHOU: CNPJ com formato errado foi aceito';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.clientes (tipo, nome, cnpj) values ('PJ', 'CNPJ repetido', '12345678000199');
    raise exception 'FALHOU: CNPJ repetido foi aceito';
  exception when unique_violation then null;
  end;
  begin
    insert into escritorio.clientes (tipo, nome) values ('ONG', 'Tipo inválido');
    raise exception 'FALHOU: tipo de cliente inválido foi aceito';
  exception when check_violation then null;
  end;
  begin
    insert into escritorio.cliente_pessoas (cliente_id, pessoa_id, papel)
      values ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000f1', 'vizinho');
    raise exception 'FALHOU: papel inválido foi aceito';
  exception when check_violation then null;
  end;
  -- Documento é do cliente; o processo é opcional, mas tem de ser DELE.
  insert into escritorio.documentos (cliente_id, processo_id, tipo, nome_arquivo, caminho_storage, origem)
    values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
            'cnis', 'cnis-ana.pdf', 'clientes/a/cnis-ana.pdf', 'whatsapp');
  begin
    insert into escritorio.documentos (cliente_id, processo_id, tipo, nome_arquivo, caminho_storage, origem)
      values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1',
              'outro', 'x.pdf', 'clientes/a/x.pdf', 'equipe');
    raise exception 'FALHOU: documento ligado a processo de outro cliente foi aceito';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into escritorio.documentos (cliente_id, tipo, nome_arquivo, caminho_storage, origem)
      values ('00000000-0000-0000-0000-00000000000a', 'outro', 'x.pdf', 'clientes/a/x.pdf', 'pombo');
    raise exception 'FALHOU: origem de documento inválida foi aceita';
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
    perform 1 from escritorio.pessoas limit 1;
    raise exception 'FALHOU: crm_leitor leu escritorio.pessoas';
  exception when insufficient_privilege then null;
  end;
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
  begin
    perform 1 from escritorio.documentos limit 1;
    raise exception 'FALHOU: crm_leitor leu escritorio.documentos';
  exception when insufficient_privilege then null;
  end;

  -- O catálogo que o conector lista só mostra as views da IA.
  select count(*) into n from information_schema.tables
   where table_schema not in ('pg_catalog', 'information_schema')
     and table_schema <> 'ia';
  if n <> 0 then
    raise exception 'FALHOU: crm_leitor enxerga % objeto(s) fora do schema ia', n;
  end if;

  -- Nenhuma coluna de CPF nem de CNPJ nas views.
  select count(*) into n from information_schema.columns
   where table_schema = 'ia' and (column_name ilike '%cpf%' or column_name ilike '%cnpj%');
  if n <> 0 then
    raise exception 'FALHOU: view da IA expõe coluna de CPF/CNPJ';
  end if;

  -- Ana: dois processos, pelo telefone com ou sem o nono dígito.
  select count(distinct numero_cnj) into n from ia.processos where telefone = '+5511987654321';
  if n <> 2 then raise exception 'FALHOU: Ana deveria ver 2 processos, viu %', n; end if;
  select count(distinct numero_cnj) into n from ia.processos where telefone = '+551187654321';
  if n <> 2 then raise exception 'FALHOU: telefone sem o nono dígito não achou os processos da Ana'; end if;

  -- O último andamento mostrado é o LIBERADO, não o rascunho mais novo.
  perform 1 from ia.processos
   where telefone = '+5511987654321' and apelido = 'Aposentadoria por idade'
     and ultimo_andamento = 'A perícia foi marcada.';
  if not found then raise exception 'FALHOU: último andamento não é o liberado'; end if;

  -- Processo sem nada liberado aparece, mas sem andamento.
  perform 1 from ia.processos
   where telefone = '+5511987654321' and apelido = 'Revisão do benefício'
     and ultimo_andamento is null;
  if not found then raise exception 'FALHOU: processo sem andamento liberado sumiu ou mostrou rascunho'; end if;

  -- Histórico: só liberados.
  select count(*) into n from ia.andamentos where texto_para_cliente like 'RASCUNHO%';
  if n <> 0 then raise exception 'FALHOU: ia.andamentos mostrou rascunho'; end if;
  select count(distinct texto_para_cliente) into n from ia.andamentos where telefone = '+5511987654321';
  if n <> 1 then raise exception 'FALHOU: Ana deveria ver 1 andamento liberado, viu %', n; end if;

  -- Ana não vê o processo do Bruno nem o da empresa.
  select count(*) into n from ia.processos
   where telefone = '+5511987654321' and apelido in ('Ação do Bruno', 'Execução fiscal da XYZ');
  if n <> 0 then raise exception 'FALHOU: Ana viu processo que não é dela'; end if;

  -- PJ: sócia e contador veem o processo da empresa, com o nome do cliente.
  perform 1 from ia.processos
   where telefone = '+5521977776666' and apelido = 'Execução fiscal da XYZ'
     and cliente = 'Empresa XYZ Ltda' and tipo_cliente = 'PJ' and papel = 'socio';
  if not found then raise exception 'FALHOU: sócia não viu o processo da empresa'; end if;
  perform 1 from ia.processos
   where telefone = '+5521966665555' and apelido = 'Execução fiscal da XYZ' and papel = 'contador';
  if not found then raise exception 'FALHOU: contador autorizado não viu o processo da empresa'; end if;
  select count(*) into n from ia.andamentos where telefone = '+5521977776666';
  if n <> 1 then raise exception 'FALHOU: sócia deveria ver 1 andamento da empresa, viu %', n; end if;

  -- Conferência do CPF: só sim ou não, e só para o dono do telefone.
  if not ia.conferir_cpf('+5511987654321', '472') then raise exception 'FALHOU: CPF certo não conferiu'; end if;
  if not ia.conferir_cpf('+551187654321', '472') then raise exception 'FALHOU: CPF certo sem o nono dígito não conferiu'; end if;
  if ia.conferir_cpf('+5511987654321', '473') then raise exception 'FALHOU: CPF errado conferiu'; end if;
  if ia.conferir_cpf('+5531988887777', '472') then raise exception 'FALHOU: CPF da Ana conferiu no telefone do Bruno'; end if;
  if ia.conferir_cpf('+5511900000000', '472') then raise exception 'FALHOU: telefone desconhecido conferiu'; end if;
  if ia.conferir_cpf('+5511987654321', '') then raise exception 'FALHOU: dígitos vazios conferiram'; end if;
  if ia.conferir_cpf('+5511987654321', null) then raise exception 'FALHOU: dígitos nulos conferiram'; end if;
  -- Na PJ confere o CPF de QUEM fala (a pessoa autorizada), não da empresa.
  if not ia.conferir_cpf('+5521977776666', '345') then raise exception 'FALHOU: CPF da sócia não conferiu'; end if;
  if ia.conferir_cpf('+5521977776666', '678') then raise exception 'FALHOU: CPF do contador conferiu no telefone da sócia'; end if;
end $$;

reset role;
\echo 'OK: todos os testes do banco de processos passaram'
rollback;
