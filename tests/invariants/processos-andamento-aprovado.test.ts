import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * PROCESSOS — O ANDAMENTO APROVADO É O TEXTO QUE FOI APROVADO (migration 0707).
 *
 * O andamento é o texto que a IA vai contar AO CLIENTE (PR 3). O que chega a
 * ele precisa ser exatamente o que uma pessoa da equipe aprovou, e isso é do
 * schema, não da rota:
 *
 *   1. a coerência mora num CHECK: rascunho não tem aprovação; aprovado tem
 *      data e o `hash_aprovado` = sha256 do texto. Reescrever o texto aprovado
 *      sem refazer o hash FALHA no banco — a invalidação é por construção;
 *   2. `fn_processos_andamento_aprovar` (manager+) é o único caminho de
 *      aprovar: trava a linha, recusa o que já está aprovado e grava quem, quando
 *      e o hash; `fn_processos_andamento_editar` (agent+) grava o texto novo e
 *      DEVOLVE a rascunho, zerando a aprovação;
 *   3. as duas compilam sem as tabelas (D7) e recusam sessão de outra
 *      organização, papel abaixo do exigido e chamada sem usuário;
 *   4. a anonimização do contato alcança o módulo pela seção declarada (D8):
 *      apelido e texto viram `[redigido]`, o número CNJ e o hash somem — e o
 *      andamento aprovado continua passando no CHECK;
 *   5. a junção de contatos duplicados reponta o processo para quem ficou.
 */
const ORG = "07071111-0000-4000-8000-000000000001";
const ORG_B = "07071111-0000-4000-8000-000000000002";
const GERENTE = "07071111-1111-4000-8000-000000000001";
const AGENTE = "07071111-1111-4000-8000-000000000002";
const ESPECTADOR = "07071111-1111-4000-8000-000000000003";
const GERENTE_B = "07071111-1111-4000-8000-000000000004";
const CLIENTE = "07071111-3333-4000-8000-000000000001";
const DUPLICADO = "07071111-3333-4000-8000-000000000002";
const ANONIMO = "07071111-3333-4000-8000-000000000003";
const PROCESSO = "07071111-4444-4000-8000-000000000001";
const PROCESSO_DO_DUPLICADO = "07071111-4444-4000-8000-000000000002";
const PROCESSO_ANONIMO = "07071111-4444-4000-8000-000000000003";
const A_APROVAR = "07071111-5555-4000-8000-000000000001";
const A_EDITAR = "07071111-5555-4000-8000-000000000002";
const DO_ANONIMO_APROVADO = "07071111-5555-4000-8000-000000000003";
const DO_ANONIMO_RASCUNHO = "07071111-5555-4000-8000-000000000004";

const HASH_SQL = (texto: string) => `encode(sha256(convert_to('${texto}', 'UTF8')), 'hex')`;

function como(usuario: string, consulta: string): string {
  return sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', false);
    ${consulta}`);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return `${(err as Error).message}${(err as { stderr?: string }).stderr ?? ""}`;
  }
  return "";
}

const aprovar = (org: string, id: string) => `select public.fn_processos_andamento_aprovar('${org}', '${id}')::text;`;
const editar = (org: string, id: string, texto: string) =>
  `select public.fn_processos_andamento_editar('${org}', '${id}', '${texto}')::text;`;

function linha(id: string): string {
  return lastLine(
    sql(`select concat_ws('|', status, texto, coalesce(aprovado_por::text, '-'),
                          (aprovado_em is not null)::text, coalesce(hash_aprovado, '-'))
           from public.andamentos where id = '${id}';`),
  );
}

describe("D7: as RPCs existem antes de o módulo ser instalado", () => {
  it("sem as tabelas, as duas funções estão no catálogo, prontas para o provisionar", () => {
    expect(lastLine(sql(`select coalesce(to_regclass('public.andamentos')::text, 'ausente');`))).toBe("ausente");
    expect(
      lastLine(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('fn_processos_andamento_aprovar', 'fn_processos_andamento_editar');`)),
    ).toBe("2");
  });

  it("anon não executa; authenticated executa (as rotas são da sessão)", () => {
    for (const fn of [
      "public.fn_processos_andamento_aprovar(uuid, uuid)",
      "public.fn_processos_andamento_editar(uuid, uuid, text)",
    ]) {
      expect(lastLine(sql(`select has_function_privilege('anon', '${fn}', 'EXECUTE')::text;`))).toBe("false");
      expect(lastLine(sql(`select has_function_privilege('authenticated', '${fn}', 'EXECUTE')::text;`))).toBe("true");
    }
  });
});

describe("o andamento aprovado", () => {
  beforeAll(() => {
    sql(`
      select public.fn_processos_provisionar();

      insert into auth.users (id, email) values
        ('${GERENTE}', 'processos-gerente@invariant.test'),
        ('${AGENTE}', 'processos-agente@invariant.test'),
        ('${ESPECTADOR}', 'processos-viewer@invariant.test'),
        ('${GERENTE_B}', 'processos-gerente-b@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG}', 'processos-aprovado', 'Processos Aprovado', 'Proc A'),
        ('${ORG_B}', 'processos-aprovado-b', 'Processos Aprovado B', 'Proc B')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${GERENTE}', '${ORG}', 'manager', now()),
        ('${AGENTE}', '${ORG}', 'agent', now()),
        ('${ESPECTADOR}', '${ORG}', 'viewer', now()),
        ('${GERENTE_B}', '${ORG_B}', 'manager', now())
        on conflict do nothing;
      insert into public.contacts (id, organization_id, name) values
        ('${CLIENTE}', '${ORG}', 'Cliente'),
        ('${DUPLICADO}', '${ORG}', 'Cliente duplicado'),
        ('${ANONIMO}', '${ORG}', 'Cliente que pede anonimização')
        on conflict (id) do nothing;
      insert into public.processos (id, organization_id, contact_id, numero_cnj, apelido, area, advogado_user_id) values
        ('${PROCESSO}', '${ORG}', '${CLIENTE}', '0000001-11.2026.8.13.0024', 'Ação do cliente', 'civel', '${GERENTE}'),
        ('${PROCESSO_DO_DUPLICADO}', '${ORG}', '${DUPLICADO}', '0000002-22.2026.8.13.0024', 'Ação na ficha duplicada', 'civel', null),
        ('${PROCESSO_ANONIMO}', '${ORG}', '${ANONIMO}', '0000003-33.2026.8.13.0024', 'Divórcio da Maria', 'familia', null)
        on conflict (id) do nothing;
      insert into public.andamentos (id, organization_id, processo_id, texto, criado_por) values
        ('${A_APROVAR}', '${ORG}', '${PROCESSO}', 'Petição protocolada', '${AGENTE}'),
        ('${A_EDITAR}', '${ORG}', '${PROCESSO}', 'Texto antigo', '${AGENTE}'),
        ('${DO_ANONIMO_RASCUNHO}', '${ORG}', '${PROCESSO_ANONIMO}', 'Maria, saiu a guarda', null)
        on conflict (id) do nothing;
      insert into public.andamentos (id, organization_id, processo_id, texto, status, aprovado_por, aprovado_em, hash_aprovado) values
        ('${DO_ANONIMO_APROVADO}', '${ORG}', '${PROCESSO_ANONIMO}', 'Maria, audiência dia 10', 'aprovado',
         '${GERENTE}', now(), ${HASH_SQL("Maria, audiência dia 10")})
        on conflict (id) do nothing;
    `);
  });

  describe("1 · a coerência é do schema", () => {
    it("rascunho com aprovação é recusado", () => {
      expect(
        erroDe(() =>
          sql(`insert into public.andamentos (organization_id, processo_id, texto, aprovado_em)
               values ('${ORG}', '${PROCESSO}', 'x', now());`),
        ),
      ).toContain("andamentos_aprovacao_coerente");
    });

    it("aprovado sem data ou com hash de OUTRO texto é recusado", () => {
      expect(
        erroDe(() =>
          sql(`insert into public.andamentos (organization_id, processo_id, texto, status, hash_aprovado)
               values ('${ORG}', '${PROCESSO}', 'x', 'aprovado', ${HASH_SQL("x")});`),
        ),
      ).toContain("andamentos_aprovacao_coerente");
      expect(
        erroDe(() =>
          sql(`insert into public.andamentos (organization_id, processo_id, texto, status, aprovado_em, hash_aprovado)
               values ('${ORG}', '${PROCESSO}', 'x', 'aprovado', now(), ${HASH_SQL("outro")});`),
        ),
      ).toContain("andamentos_aprovacao_coerente");
    });

    it("⭐ reescrever o texto aprovado sem refazer o hash FALHA — nem o dono do banco escapa", () => {
      expect(
        erroDe(() => sql(`update public.andamentos set texto = 'Maria, audiência dia 11' where id = '${DO_ANONIMO_APROVADO}';`)),
      ).toContain("andamentos_aprovacao_coerente");
      expect(linha(DO_ANONIMO_APROVADO)).toContain("aprovado|Maria, audiência dia 10|");
    });
  });

  describe("2 · aprovar e editar só pelas RPCs", () => {
    it("⭐ agent e viewer não aprovam; manager aprova e grava quem, quando e o hash", () => {
      for (const usuario of [AGENTE, ESPECTADOR]) {
        expect(erroDe(() => como(usuario, aprovar(ORG, A_APROVAR)))).toContain("processos_forbidden");
      }
      const r = JSON.parse(lastLine(como(GERENTE, aprovar(ORG, A_APROVAR))));
      expect(r).toMatchObject({ id: A_APROVAR, status: "aprovado" });
      const hash = lastLine(sql(`select ${HASH_SQL("Petição protocolada")};`));
      expect(r.hash_aprovado).toBe(hash);
      expect(linha(A_APROVAR)).toBe(`aprovado|Petição protocolada|${GERENTE}|true|${hash}`);
    });

    it("aprovar de novo é recusado e não mexe na aprovação", () => {
      const antes = linha(A_APROVAR);
      expect(erroDe(() => como(GERENTE, aprovar(ORG, A_APROVAR)))).toContain("andamento_ja_aprovado");
      expect(linha(A_APROVAR)).toBe(antes);
    });

    it("⭐ editar o aprovado grava o texto novo e DEVOLVE a rascunho, zerando a aprovação", () => {
      const r = JSON.parse(lastLine(como(AGENTE, editar(ORG, A_APROVAR, "Petição protocolada e distribuída"))));
      expect(r).toMatchObject({ id: A_APROVAR, status: "rascunho" });
      expect(linha(A_APROVAR)).toBe("rascunho|Petição protocolada e distribuída|-|false|-");
    });

    it("editar o rascunho também funciona, e viewer não edita", () => {
      expect(erroDe(() => como(ESPECTADOR, editar(ORG, A_EDITAR, "x")))).toContain("processos_forbidden");
      como(AGENTE, editar(ORG, A_EDITAR, "Texto novo"));
      expect(linha(A_EDITAR)).toBe("rascunho|Texto novo|-|false|-");
    });

    it("texto vazio ou longo demais é recusado pelo schema, também pela RPC", () => {
      expect(erroDe(() => como(AGENTE, editar(ORG, A_EDITAR, "   ")))).toMatch(/andamentos_texto_check|check constraint/);
      expect(linha(A_EDITAR)).toBe("rascunho|Texto novo|-|false|-");
    });

    it("⭐ o gerente da OUTRA organização não aprova nem edita, nem com o id na mão", () => {
      expect(erroDe(() => como(GERENTE_B, aprovar(ORG, A_EDITAR)))).toContain("processos_forbidden");
      expect(erroDe(() => como(GERENTE_B, aprovar(ORG_B, A_EDITAR)))).toContain("andamento_nao_encontrado");
      expect(erroDe(() => como(GERENTE_B, editar(ORG_B, A_EDITAR, "x")))).toContain("andamento_nao_encontrado");
      expect(linha(A_EDITAR)).toBe("rascunho|Texto novo|-|false|-");
    });

    it("sem usuário (service key) as RPCs recusam: aprovar é ato de uma pessoa", () => {
      expect(erroDe(() => sql(aprovar(ORG, A_EDITAR)))).toContain("processos_forbidden");
      expect(erroDe(() => sql(editar(ORG, A_EDITAR, "x")))).toContain("processos_forbidden");
    });
  });

  describe("4 · a anonimização alcança o módulo pela seção declarada (D8)", () => {
    it("as duas seções estão declaradas em modulo_secoes_lgpd", () => {
      expect(
        lastLine(sql(`select string_agg(tabela, ',' order by tabela) from public.modulo_secoes_lgpd
                       where modulo = 'processos';`)),
      ).toBe("andamentos,processos");
    });

    it("⭐ apelido e texto viram [redigido], CNJ e hash somem — o aprovado segue válido no CHECK", () => {
      sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ANONIMO}', gen_random_uuid());`);
      expect(
        lastLine(sql(`select concat_ws('|', apelido, coalesce(numero_cnj, '-'), area, contact_id)
                       from public.processos where id = '${PROCESSO_ANONIMO}';`)),
      ).toBe(`[redigido]|-|familia|${ANONIMO}`);
      expect(linha(DO_ANONIMO_APROVADO)).toBe(`aprovado|[redigido]|${GERENTE}|true|-`);
      expect(linha(DO_ANONIMO_RASCUNHO)).toBe("rascunho|[redigido]|-|false|-");
      // O controle: o processo de outro contato não foi tocado.
      expect(lastLine(sql(`select apelido from public.processos where id = '${PROCESSO}';`))).toBe("Ação do cliente");
    });
  });

  describe("5 · a junção de contatos duplicados", () => {
    it("⭐ o processo da ficha que sai passa a apontar para a que fica (FK composta repontada)", () => {
      sql(`select public.fn_mesclar_contatos('${ORG}', '${CLIENTE}', array['${DUPLICADO}']::uuid[]);`);
      expect(lastLine(sql(`select contact_id from public.processos where id = '${PROCESSO_DO_DUPLICADO}';`))).toBe(CLIENTE);
      expect(lastLine(sql(`select contact_id from public.processos where id = '${PROCESSO}';`))).toBe(CLIENTE);
    });
  });
});
