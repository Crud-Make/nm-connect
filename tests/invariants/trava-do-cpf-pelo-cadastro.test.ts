/**
 * A TRAVA DO CPF PELO CADASTRO DO CONTATO, NO BANCO DE VERDADE (migration 0706).
 *
 * Duas peças, medidas pelo efeito:
 *
 *   1. `verificacoes_de_identidade.connection_id` aceita NULL (= conferência
 *      contra o cadastro, sem banco externo), e a unicidade continua valendo
 *      UMA linha por contato também quando a conexão é nula — sem o
 *      `nulls not distinct`, o upsert de `gravarConferencia` abriria uma linha
 *      por tentativa e a contagem de erros nunca chegaria a 3;
 *   2. `fn_conferir_cpf_do_contato` devolve só NULL/true/false, compara apenas
 *      os 3 últimos dígitos do CPF cifrado do contato, não atravessa
 *      organização e só `service_role` a executa.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "07060000-0000-4000-8000-000000000001";
const OUTRA_ORG = "07060000-0000-4000-8000-000000000002";
const COM_CPF = "07060000-3333-4000-8000-000000000001";
const SEM_CPF = "07060000-3333-4000-8000-000000000002";
const CPF_COM_MASCARA = "529.982.247-25";

function ultima(saida: string): string {
  return (saida.trim().split("\n").at(-1) ?? "").trim();
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

function conferir(org: string, contato: string, digitos: string | null): string {
  const d = digitos === null ? "null" : `'${digitos}'`;
  return ultima(sql(`select coalesce(public.fn_conferir_cpf_do_contato('${org}', '${contato}', ${d})::text, 'nulo');`));
}

function linhasDoContato(contato: string): number {
  return Number(
    ultima(sql(`select count(*) from public.verificacoes_de_identidade
                 where contact_id = '${contato}' and connection_id is null;`)),
  );
}

beforeAll(() => {
  sql(`
    insert into private.app_secrets (name, value) values ('cpf_key', repeat('k', 44))
      on conflict (name) do update set value = excluded.value;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'trava-0706', 'Trava 0706', 'Trava 0706'),
      ('${OUTRA_ORG}', 'trava-0706-b', 'Trava 0706 B', 'Trava 0706 B')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, name, cpf_hash, cpf_encrypted) values
      ('${COM_CPF}', '${ORG}', 'Com CPF', 'hash-0706', public.encrypt_cpf('${CPF_COM_MASCARA}'))
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name) values
      ('${SEM_CPF}', '${ORG}', 'Sem CPF')
      on conflict (id) do nothing;
  `);
});

describe("verificacoes_de_identidade com a conexão nula (0706)", () => {
  it("a coluna aceita NULL e a unicidade é nulls not distinct", () => {
    expect(
      ultima(sql(`select is_nullable from information_schema.columns
                   where table_schema = 'public' and table_name = 'verificacoes_de_identidade'
                     and column_name = 'connection_id';`)),
    ).toBe("YES");
    expect(
      ultima(sql(`select pg_get_constraintdef(oid) from pg_constraint
                   where conname = 'verificacoes_de_identidade_unica';`)),
    ).toBe("UNIQUE NULLS NOT DISTINCT (organization_id, contact_id, connection_id)");
  });

  it("uma linha por contato com a conexão nula: o segundo insert é recusado e o upsert converge", () => {
    sql(`insert into public.verificacoes_de_identidade (organization_id, contact_id, connection_id, tentativas_falhas)
         values ('${ORG}', '${COM_CPF}', null, 1);`);
    expect(
      erroDe(() =>
        sql(`insert into public.verificacoes_de_identidade (organization_id, contact_id, connection_id, tentativas_falhas)
             values ('${ORG}', '${COM_CPF}', null, 2);`),
      ),
    ).toContain("verificacoes_de_identidade_unica");

    // O mesmo `on conflict` que o upsert do PostgREST monta em gravarConferencia.
    sql(`insert into public.verificacoes_de_identidade (organization_id, contact_id, connection_id, tentativas_falhas)
         values ('${ORG}', '${COM_CPF}', null, 2)
         on conflict (organization_id, contact_id, connection_id)
         do update set tentativas_falhas = excluded.tentativas_falhas;`);
    expect(linhasDoContato(COM_CPF)).toBe(1);
    expect(
      ultima(sql(`select tentativas_falhas from public.verificacoes_de_identidade
                   where contact_id = '${COM_CPF}' and connection_id is null;`)),
    ).toBe("2");
  });
});

describe("fn_conferir_cpf_do_contato (0706)", () => {
  it("os 3 últimos dígitos conferem: true — com o CPF gravado com máscara", () => {
    expect(conferir(ORG, COM_CPF, "725")).toBe("true");
  });

  it("dígitos errados, dígitos do meio ou formato inválido: false", () => {
    expect(conferir(ORG, COM_CPF, "724")).toBe("false");
    expect(conferir(ORG, COM_CPF, "529")).toBe("false");
    expect(conferir(ORG, COM_CPF, "25")).toBe("false");
    expect(conferir(ORG, COM_CPF, "7a5")).toBe("false");
    expect(conferir(ORG, COM_CPF, null)).toBe("false");
  });

  it("contato sem CPF: NULL — não há com o que conferir", () => {
    expect(conferir(ORG, SEM_CPF, "725")).toBe("nulo");
  });

  it("o contato de OUTRA organização não é alcançado: NULL, nunca a resposta do vizinho", () => {
    expect(conferir(OUTRA_ORG, COM_CPF, "725")).toBe("nulo");
  });

  it("devolve boolean — o CPF não tem por onde sair", () => {
    expect(
      ultima(sql(`select format_type(prorettype, null) from pg_proc
                   where oid = 'public.fn_conferir_cpf_do_contato(uuid, uuid, text)'::regprocedure;`)),
    ).toBe("boolean");
  });

  it("EXECUTE só de service_role: anon, authenticated e PUBLIC não executam", () => {
    const pode = (papel: string) =>
      ultima(sql(`select has_function_privilege('${papel}',
                   'public.fn_conferir_cpf_do_contato(uuid, uuid, text)', 'EXECUTE')::text;`));
    expect(pode("service_role")).toBe("true");
    expect(pode("anon")).toBe("false");
    expect(pode("authenticated")).toBe("false");
    expect(
      ultima(sql(`select coalesce(array_to_string(proacl, ' '), 'padrao') from pg_proc
                   where oid = 'public.fn_conferir_cpf_do_contato(uuid, uuid, text)'::regprocedure;`)),
    ).not.toMatch(/(^| )=X/);
  });

  it("sob a sessão de um usuário logado a chamada é recusada", () => {
    const erro = erroDe(() =>
      sql(`set role authenticated;
           select public.fn_conferir_cpf_do_contato('${ORG}', '${COM_CPF}', '725');`),
    );
    expect(erro).toMatch(/permission denied/i);
  });
});
