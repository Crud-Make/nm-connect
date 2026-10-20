import { beforeAll, describe, expect, it } from "vitest";

import {
  countAs,
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * A RLS DO MÓDULO PROCESSOS É POR OPERAÇÃO (migration 0707).
 *
 * O PostgREST fala com o JWT da sessão direto, sem rota nenhuma (0150), e o
 * baseline dá GRANT ALL a `authenticated`: a policy é a única porta. Molde de
 * honorários (0480), com os papéis deste módulo:
 *
 *   processos   SELECT viewer+ · INSERT/UPDATE agent+ · DELETE manager+;
 *   andamentos  SELECT: o APROVADO para viewer+, qualquer status para agent+ ·
 *               INSERT/UPDATE/DELETE agent+ e SÓ em rascunho.
 *
 * O andamento é o texto que vai PARA O CLIENTE. O aprovado não se reescreve,
 * não se apaga e não volta a rascunho pela sessão — isso só pelas RPCs
 * `fn_processos_andamento_aprovar`/`_editar` (arquivo irmão). E a sessão não
 * aprova à mão: a aprovação carrega quem aprovou e o hash do texto.
 */
const ORG_B = "07070000-9999-4000-8000-0000000000b0";
const CONTATO_B = "07070000-9999-4000-8000-0000000000c0";
const PROCESSO = "07070000-1111-4000-8000-000000000001";
const PROCESSO_DESCARTE = "07070000-1111-4000-8000-000000000002";
const PROCESSO_B = "07070000-1111-4000-8000-0000000000b1";
const RASCUNHO = "07070000-2222-4000-8000-000000000001";
const RASCUNHO_DESCARTE = "07070000-2222-4000-8000-000000000002";
const APROVADO = "07070000-2222-4000-8000-000000000003";
const ANDAMENTO_B = "07070000-2222-4000-8000-0000000000b1";
const CNJ = "0001234-56.2026.8.13.0024";

const HASH = (texto: string) => `encode(sha256(convert_to('${texto}', 'UTF8')), 'hex')`;

function existe(tabela: string, id: string): boolean {
  return lastLine(sql(`select exists(select 1 from public.${tabela} where id = '${id}')::text;`)) === "true";
}

function textoDo(andamento: string): string {
  return lastLine(sql(`select texto || '|' || status from public.andamentos where id = '${andamento}';`));
}

/** O erro de uma escrita como postgres (CHECK/FK, que a RLS não explica). */
function erroDe(script: string): string {
  try {
    sql(script);
  } catch (err) {
    return `${(err as Error).message}${(err as { stderr?: string }).stderr ?? ""}`;
  }
  return "";
}

beforeAll(() => {
  seedGov();
  sql(`
    select public.fn_processos_provisionar();

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_B}', 'processos-rls-b', 'Processos RLS B', 'Proc RLS B')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_B}', '${ORG_B}', 'Cliente da B')
      on conflict (id) do nothing;
    insert into public.processos (id, organization_id, contact_id, numero_cnj, apelido, area) values
      ('${PROCESSO}', '${GOV_ORG}', '${GOV_CONTACT_1}', '${CNJ}', 'Ação de alimentos', 'familia'),
      ('${PROCESSO_DESCARTE}', '${GOV_ORG}', '${GOV_CONTACT_1}', null, 'A distribuir', 'civel'),
      ('${PROCESSO_B}', '${ORG_B}', '${CONTATO_B}', '${CNJ}', 'Processo da B', 'trabalhista')
      on conflict (id) do nothing;
    insert into public.andamentos (id, organization_id, processo_id, texto) values
      ('${RASCUNHO}', '${GOV_ORG}', '${PROCESSO}', 'Rascunho para o cliente'),
      ('${RASCUNHO_DESCARTE}', '${GOV_ORG}', '${PROCESSO}', 'Rascunho descartável'),
      ('${ANDAMENTO_B}', '${ORG_B}', '${PROCESSO_B}', 'Andamento da B')
      on conflict (id) do nothing;
    insert into public.andamentos (id, organization_id, processo_id, texto, status, aprovado_por, aprovado_em, hash_aprovado)
      values ('${APROVADO}', '${GOV_ORG}', '${PROCESSO}', 'Audiência marcada', 'aprovado',
              '${GOV_MANAGER}', now(), ${HASH("Audiência marcada")})
      on conflict (id) do nothing;
  `);
});

describe("o schema recusa o que não é processo", () => {
  it("o número fora do formato CNJ, a área fora da lista e o apelido vazio são recusados", () => {
    expect(
      erroDe(`insert into public.processos (organization_id, contact_id, numero_cnj, apelido, area)
              values ('${GOV_ORG}', '${GOV_CONTACT_1}', '12345', 'x', 'civel');`),
    ).toContain("processos_numero_cnj_formato");
    expect(
      erroDe(`insert into public.processos (organization_id, contact_id, apelido, area)
              values ('${GOV_ORG}', '${GOV_CONTACT_1}', 'x', 'astrologia');`),
    ).toMatch(/processos_area_check|check constraint/);
    expect(
      erroDe(`insert into public.processos (organization_id, contact_id, apelido, area)
              values ('${GOV_ORG}', '${GOV_CONTACT_1}', '   ', 'civel');`),
    ).toMatch(/processos_apelido_check|check constraint/);
  });

  it("o mesmo número CNJ não se repete na organização — e na vizinha pode", () => {
    expect(
      erroDe(`insert into public.processos (organization_id, contact_id, numero_cnj, apelido, area)
              values ('${GOV_ORG}', '${GOV_CONTACT_1}', '${CNJ}', 'Duplicado', 'civel');`),
    ).toContain("processos_numero_unico");
    // O controle: a organização B já tem o MESMO número (seed) sem colisão.
    expect(existe("processos", PROCESSO_B)).toBe(true);
  });

  it("a fase nasce em conhecimento", () => {
    expect(lastLine(sql(`select fase from public.processos where id = '${PROCESSO}';`))).toBe("conhecimento");
  });

  it("⭐ o processo não aponta para o contato de OUTRA organização (FK composta)", () => {
    expect(
      erroDe(`insert into public.processos (organization_id, contact_id, apelido, area)
              values ('${GOV_ORG}', '${CONTATO_B}', 'Ponte entre tenants', 'civel');`),
    ).toContain("processos_contato_fkey");
  });

  it("⭐ o andamento não pendura em processo de OUTRA organização (FK composta)", () => {
    expect(
      erroDe(`insert into public.andamentos (organization_id, processo_id, texto)
              values ('${GOV_ORG}', '${PROCESSO_B}', 'Ponte entre tenants');`),
    ).toContain("andamentos_processo_fkey");
  });
});

describe("processos: viewer lê, agent escreve, manager apaga", () => {
  it("viewer lê e não escreve", () => {
    expect(countAs(GOV_VIEWER, `select count(*) from public.processos where id = '${PROCESSO}'`)).toBe(1);
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.processos (organization_id, contact_id, apelido, area) values ('${GOV_ORG}', '${GOV_CONTACT_1}', 'x', 'civel')`,
      ),
    ).toBe(0);
    expect(writeCountAs(GOV_VIEWER, `update public.processos set apelido = 'x' where id = '${PROCESSO}'`)).toBe(0);
    expect(writeCountAs(GOV_VIEWER, `delete from public.processos where id = '${PROCESSO_DESCARTE}'`)).toBe(0);
  });

  it("agent cria e edita, e não apaga", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.processos (organization_id, contact_id, apelido, area) values ('${GOV_ORG}', '${GOV_CONTACT_1}', 'Novo do agent', 'previdenciario')`,
      ),
    ).toBe(1);
    expect(writeCountAs(GOV_AGENT_A, `update public.processos set fase = 'recurso' where id = '${PROCESSO}'`)).toBe(1);
    expect(writeCountAs(GOV_AGENT_A, `delete from public.processos where id = '${PROCESSO_DESCARTE}'`)).toBe(0);
    expect(existe("processos", PROCESSO_DESCARTE)).toBe(true);
  });

  it("manager apaga — controle positivo", () => {
    expect(writeCountAs(GOV_MANAGER, `delete from public.processos where id = '${PROCESSO_DESCARTE}'`)).toBe(1);
  });

  it("⭐ ninguém da organização A lê nem escreve o processo da B", () => {
    expect(countAs(GOV_MANAGER, `select count(*) from public.processos where id = '${PROCESSO_B}'`)).toBe(0);
    expect(writeCountAs(GOV_MANAGER, `update public.processos set apelido = 'x' where id = '${PROCESSO_B}'`)).toBe(0);
    expect(writeCountAs(GOV_MANAGER, `delete from public.processos where id = '${PROCESSO_B}'`)).toBe(0);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.processos (organization_id, contact_id, apelido, area) values ('${ORG_B}', '${CONTATO_B}', 'x', 'civel')`,
      ),
    ).toBe(0);
  });
});

describe("andamentos: o aprovado é o que o viewer vê, e a sessão não o muda", () => {
  it("viewer lê só o aprovado; agent lê os dois", () => {
    const daOrg = `select count(*) from public.andamentos where id in ('${RASCUNHO}', '${APROVADO}')`;
    expect(countAs(GOV_VIEWER, daOrg)).toBe(1);
    expect(countAs(GOV_VIEWER, `select count(*) from public.andamentos where id = '${APROVADO}'`)).toBe(1);
    expect(countAs(GOV_AGENT_A, daOrg)).toBe(2);
  });

  it("agent cria rascunho; viewer não cria nada", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.andamentos (organization_id, processo_id, texto) values ('${GOV_ORG}', '${PROCESSO}', 'Novo rascunho')`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.andamentos (organization_id, processo_id, texto) values ('${GOV_ORG}', '${PROCESSO}', 'x')`,
      ),
    ).toBe(0);
  });

  it("⭐ ninguém nasce aprovado pela sessão — nem com a aprovação completa e o hash certo", () => {
    for (const usuario of [GOV_AGENT_A, GOV_MANAGER]) {
      expect(
        writeCountAs(
          usuario,
          `insert into public.andamentos (organization_id, processo_id, texto, status, aprovado_por, aprovado_em, hash_aprovado)
           values ('${GOV_ORG}', '${PROCESSO}', 'Aprovado à mão', 'aprovado', '${usuario}', now(), ${HASH("Aprovado à mão")})`,
        ),
      ).toBe(0);
    }
  });

  it("agent edita o rascunho — controle positivo", () => {
    expect(writeCountAs(GOV_AGENT_A, `update public.andamentos set texto = 'Rascunho revisto' where id = '${RASCUNHO}'`)).toBe(1);
    expect(textoDo(RASCUNHO)).toBe("Rascunho revisto|rascunho");
  });

  it("⭐ nem manager reescreve o aprovado, nem o devolve a rascunho, nem aprova à mão", () => {
    expect(writeCountAs(GOV_MANAGER, `update public.andamentos set texto = 'Reescrito' where id = '${APROVADO}'`)).toBe(0);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.andamentos set status = 'rascunho', aprovado_por = null, aprovado_em = null, hash_aprovado = null where id = '${APROVADO}'`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.andamentos set status = 'aprovado', aprovado_por = '${GOV_MANAGER}', aprovado_em = now(), hash_aprovado = ${HASH("Rascunho revisto")} where id = '${RASCUNHO}'`,
      ),
    ).toBe(0);
    expect(textoDo(APROVADO)).toBe("Audiência marcada|aprovado");
    expect(textoDo(RASCUNHO)).toBe("Rascunho revisto|rascunho");
  });

  it("⭐ o aprovado não se apaga pela sessão; o rascunho, o agent apaga", () => {
    expect(writeCountAs(GOV_MANAGER, `delete from public.andamentos where id = '${APROVADO}'`)).toBe(0);
    expect(existe("andamentos", APROVADO)).toBe(true);
    expect(writeCountAs(GOV_AGENT_A, `delete from public.andamentos where id = '${RASCUNHO_DESCARTE}'`)).toBe(1);
  });

  it("⭐ ninguém da organização A lê o andamento da B", () => {
    expect(countAs(GOV_MANAGER, `select count(*) from public.andamentos where id = '${ANDAMENTO_B}'`)).toBe(0);
    expect(writeCountAs(GOV_MANAGER, `delete from public.andamentos where id = '${ANDAMENTO_B}'`)).toBe(0);
  });
});
