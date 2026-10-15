import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * 0675 — `setores` e `setor_membros`: isolamento entre organizações e escrita
 * só de manager+, medidos por JWT num Postgres real com o baseline aplicado.
 *
 * O que a RLS precisa garantir, e por quê:
 *   · leitura para TODO membro da organização — a inbox mostra o setor da
 *     conversa a quem atende (agent);
 *   · zero do vizinho, nos dois sentidos;
 *   · escrita (insert/update/delete) só manager+ — setor é configuração de
 *     equipe; um atendente que se põe no setor "certo" desvia a fila;
 *   · nem manager escreve COM o organization_id do vizinho (`with check`).
 *
 * E o ponteiro da conversa: `conversations.setor_id` só aceita setor da MESMA
 * organização (FK composta), e excluir o setor zera só o ponteiro.
 */

const ORG_A = "0675aaaa-0000-4000-8000-000000000001";
const ORG_B = "0675bbbb-0000-4000-8000-000000000002";
const AGENT_A = "0675aaaa-1111-4000-8000-000000000001";
const MANAGER_A = "0675aaaa-1111-4000-8000-000000000002";
const AGENT_B = "0675bbbb-1111-4000-8000-000000000001";
const SETOR_A = "0675aaaa-2222-4000-8000-000000000001";
const SETOR_A_APAGAR = "0675aaaa-2222-4000-8000-000000000002";
const SETOR_B = "0675bbbb-2222-4000-8000-000000000001";
const SESS_A = "0675aaaa-3333-4000-8000-000000000001";
const CT_A = "0675aaaa-4444-4000-8000-000000000001";
const CV_A = "0675aaaa-5555-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'setor-agent-a@invariant.test'),
      ('${MANAGER_A}', 'setor-manager-a@invariant.test'),
      ('${AGENT_B}', 'setor-agent-b@invariant.test')
    on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'setor-inv-a', 'Setor Inv A', 'Setor A'),
      ('${ORG_B}', 'setor-inv-b', 'Setor Inv B', 'Setor B')
    on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_B}', '${ORG_B}', 'agent', now())
    on conflict do nothing;
    insert into public.setores (id, organization_id, nome) values
      ('${SETOR_A}', '${ORG_A}', 'Tributário'),
      ('${SETOR_A_APAGAR}', '${ORG_A}', 'Temporário'),
      ('${SETOR_B}', '${ORG_B}', 'Previdenciário')
    on conflict (id) do nothing;
    insert into public.setor_membros (setor_id, user_id, organization_id) values
      ('${SETOR_A}', '${AGENT_A}', '${ORG_A}'),
      ('${SETOR_B}', '${AGENT_B}', '${ORG_B}')
    on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESS_A}', '${ORG_A}', 'setor-inv-a', '\\x00'::bytea)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CT_A}', '${ORG_A}', 'Setor Inv Contato A')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, setor_id)
      values ('${CV_A}', '${ORG_A}', '${CT_A}', '${SESS_A}', '${SETOR_A_APAGAR}')
      on conflict (id) do nothing;
  `);
});

describe.each(["setores", "setor_membros"] as const)("RLS de %s", (tabela) => {
  it("controle positivo: o agent lê a linha da PRÓPRIA organização", () => {
    expect(countAs(AGENT_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
    expect(countAs(AGENT_B, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBe(1);
  });

  it("zero do vizinho, nos dois sentidos", () => {
    expect(countAs(AGENT_A, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(AGENT_B, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("agent NÃO escreve nem na própria organização", () => {
    expect(writeCountAs(AGENT_A, `update public.${tabela} set organization_id = organization_id where organization_id = '${ORG_A}'`)).toBe(0);
    expect(writeCountAs(AGENT_A, `delete from public.${tabela} where organization_id = '${ORG_A}'`)).toBe(0);
  });

  it("manager de A não alcança a linha de B", () => {
    expect(writeCountAs(MANAGER_A, `update public.${tabela} set organization_id = organization_id where organization_id = '${ORG_B}'`)).toBe(0);
    expect(writeCountAs(MANAGER_A, `delete from public.${tabela} where organization_id = '${ORG_B}'`)).toBe(0);
  });
});

describe("escrita de setores", () => {
  it("agent não cria setor", () => {
    expect(writeCountAs(AGENT_A, `insert into public.setores (organization_id, nome) values ('${ORG_A}', 'Do agent')`)).toBe(0);
  });

  it("manager cria setor na PRÓPRIA organização (controle positivo)", () => {
    expect(writeCountAs(MANAGER_A, `insert into public.setores (organization_id, nome) values ('${ORG_A}', 'Empresarial')`)).toBe(1);
  });

  it("manager NÃO cria setor com o organization_id do vizinho (with check)", () => {
    expect(writeCountAs(MANAGER_A, `insert into public.setores (organization_id, nome) values ('${ORG_B}', 'Invasor')`)).toBe(0);
  });

  it("nome é único por organização sem diferenciar maiúsculas", () => {
    expect(() => sql(`insert into public.setores (organization_id, nome) values ('${ORG_A}', 'tributário')`)).toThrow();
    // Outra organização pode ter o mesmo nome.
    expect(() => sql(`insert into public.setores (organization_id, nome) values ('${ORG_B}', 'Tributário') on conflict do nothing`)).not.toThrow();
  });
});

describe("ponteiros para o setor", () => {
  it("membro de setor só da MESMA organização (FK composta)", () => {
    expect(() =>
      sql(`insert into public.setor_membros (setor_id, user_id, organization_id) values ('${SETOR_B}', '${AGENT_A}', '${ORG_A}')`),
    ).toThrow();
  });

  it("conversa não aponta setor de outra organização", () => {
    expect(() => sql(`update public.conversations set setor_id = '${SETOR_B}' where id = '${CV_A}'`)).toThrow();
  });

  it("excluir o setor zera só o ponteiro da conversa", () => {
    sql(`delete from public.setores where id = '${SETOR_A_APAGAR}'`);
    expect(sql(`select coalesce(setor_id::text, 'nulo') || '|' || organization_id from public.conversations where id = '${CV_A}'`)).toBe(
      `nulo|${ORG_A}`,
    );
  });
});
