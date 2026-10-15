/**
 * Carga e rodízio dos atendentes contados NO BANCO (migration 0674).
 *
 * O roteamento e o roster liam linhas pela REST e contavam em memória; o
 * `max_rows = 1000` do PostgREST corta sem erro, e a carga de quem tinha mais
 * de 1000 conversas abertas (ou a última atribuição de quem ficou além dos
 * 1000 eventos mais novos) saía errada em silêncio. Aqui a função real
 * `fn_carga_e_rodizio_dos_atendentes` é medida contra volume acima do corte:
 *
 *   - contagem certa (1200 conversas abertas; fechadas não contam);
 *   - última atribuição certa com 1100 eventos, com e sem escopo de canal;
 *   - isolamento entre 2 organizações (a mesma pessoa nas duas: a org A não vê
 *     a carga nem o evento da org B);
 *   - ACL: anon e authenticated não executam; só service_role;
 *   - o caminho real (`loadEligibleAttendants` e `carregarRosterDeAtendimento`)
 *     chega na contagem do banco.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { carregarRosterDeAtendimento } from "@/lib/escalacao/atendentes";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import { OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
import { routingPgSupabase } from "../support/routing-pg-supabase";

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG_A = "dddddddd-0000-4000-8000-0000000000a1";
const ORG_B = "dddddddd-0000-4000-8000-0000000000b1";
const ANA = "dddddddd-1111-4000-8000-000000000001";
const BRUNO = "dddddddd-1111-4000-8000-000000000002";
const CARLA = "dddddddd-1111-4000-8000-000000000003";
const CANAL_A1 = "dddddddd-2222-4000-8000-0000000000a1";
const CANAL_A2 = "dddddddd-2222-4000-8000-0000000000a2";
const CANAL_B1 = "dddddddd-2222-4000-8000-0000000000b1";
const BASE = Date.parse("2026-09-01T00:00:00Z");
const minutos = (n: number) => BASE + n * 60_000;

type Linha = { user_id: string; carga: number; ultima_atribuicao_em: string | null };

async function contar(org: string, users: string[], canal: string | null = null) {
  const r = await query(
    "select public.fn_carga_e_rodizio_dos_atendentes($1, $2::uuid[], $3::text[], $4) as r",
    [org, users, [...OPEN_LOAD_STATUSES], canal],
  );
  const linhas = r.rows[0].r as Linha[];
  return new Map(
    linhas.map((l) => [
      l.user_id,
      {
        carga: l.carga,
        ultima: l.ultima_atribuicao_em ? Date.parse(l.ultima_atribuicao_em) : null,
      },
    ]),
  );
}

beforeAll(async () => {
  await query(
    `insert into auth.users (id, email) values
       ($1, 'carga-ana@invariant.test'), ($2, 'carga-bruno@invariant.test'), ($3, 'carga-carla@invariant.test')
     on conflict do nothing`,
    [ANA, BRUNO, CARLA],
  );
  await query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'carga-a', 'Carga A', 'Carga A'), ($2, 'carga-b', 'Carga B', 'Carga B')
     on conflict do nothing`,
    [ORG_A, ORG_B],
  );
  await query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $3, 'agent', now()), ($2, $3, 'agent', now()), ($1, $4, 'agent', now())
     on conflict do nothing`,
    [ANA, BRUNO, ORG_A, ORG_B],
  );
  await query(
    `insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
       ($1, $4, 'carga-a1', '\\x00'::bytea), ($2, $4, 'carga-a2', '\\x00'::bytea), ($3, $5, 'carga-b1', '\\x00'::bytea)`,
    [CANAL_A1, CANAL_A2, CANAL_B1, ORG_A, ORG_B],
  );

  // Uma conversa por contato (único por contato+canal), em lote.
  const conversas = async (
    org: string,
    canal: string,
    tag: string,
    n: number,
    user: string | null,
    status: string,
  ) => {
    await query(
      `with novos as (
         insert into public.contacts (organization_id, display_name)
         select $1, $3::text || ' ' || g from generate_series(1, $4::int) g
         returning id
       )
       insert into public.conversations (organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
       select $1, novos.id, $2, $6, $5::uuid, now() from novos`,
      [org, canal, `carga ${tag}`, n, user, status],
    );
  };
  await conversas(ORG_A, CANAL_A1, "ana aberta", 1200, ANA, "claimed");
  await conversas(ORG_A, CANAL_A1, "ana fechada", 5, ANA, "resolved");
  await conversas(ORG_A, CANAL_A2, "bruno", 3, BRUNO, "open");
  await conversas(ORG_B, CANAL_B1, "ana org b", 7, ANA, "open");

  const evento = (org: string, canal: string, user: string, n: number, inicioMin: number) =>
    query(
      `insert into public.conversation_assignment_events (organization_id, conversation_id, to_user_id, reason, created_at)
       select $1, (select id from public.conversations where organization_id = $1 and channel_session_id = $2 limit 1),
              $3, 'routing', $5::timestamptz + make_interval(mins => g)
         from generate_series(0, $4::int - 1) g`,
      [org, canal, user, n, new Date(minutos(inicioMin)).toISOString()],
    );
  // 1100 eventos da ana no canal A1 (o mais novo em +1099 min) e um, mais novo,
  // no A2 (+5000). Bruno: um só, mais velho que todos. Ana na org B: o mais
  // novo de todos (+9999) — não pode vazar para a org A.
  await evento(ORG_A, CANAL_A1, ANA, 1100, 0);
  await evento(ORG_A, CANAL_A2, ANA, 1, 5000);
  await evento(ORG_A, CANAL_A2, BRUNO, 1, -1440);
  await evento(ORG_B, CANAL_B1, ANA, 1, 9999);
});
afterAll(() => pool.end());

describe("fn_carga_e_rodizio_dos_atendentes", () => {
  it("conta acima de 1000 linhas: carga e última atribuição certas", async () => {
    const m = await contar(ORG_A, [ANA, BRUNO, CARLA]);
    expect(m.get(ANA)).toEqual({ carga: 1200, ultima: minutos(5000) });
    expect(m.get(BRUNO)).toEqual({ carga: 3, ultima: minutos(-1440) });
    // Sem nada na org: linha presente, carga 0, nunca recebeu.
    expect(m.get(CARLA)).toEqual({ carga: 0, ultima: null });
  });

  it("escopo de canal: só eventos de conversas daquele canal; a carga continua global", async () => {
    const m = await contar(ORG_A, [ANA, BRUNO], CANAL_A1);
    expect(m.get(ANA)).toEqual({ carga: 1200, ultima: minutos(1099) });
    expect(m.get(BRUNO)).toEqual({ carga: 3, ultima: null });
  });

  it("isolamento entre organizações: a mesma pessoa, cada org vê só o seu", async () => {
    const a = await contar(ORG_A, [ANA]);
    const b = await contar(ORG_B, [ANA]);
    expect(a.get(ANA)).toEqual({ carga: 1200, ultima: minutos(5000) });
    expect(b.get(ANA)).toEqual({ carga: 7, ultima: minutos(9999) });
    // Canal de outra organização não abre nada na org A.
    expect((await contar(ORG_A, [ANA], CANAL_B1)).get(ANA)).toEqual({ carga: 1200, ultima: null });
  });

  it("ACL: anon e authenticated não executam; service_role executa; invoker com search_path fixo", async () => {
    const sig = "public.fn_carga_e_rodizio_dos_atendentes(uuid, uuid[], text[], uuid)";
    const r = await query(
      `select has_function_privilege('anon', $1, 'execute') anon,
              has_function_privilege('authenticated', $1, 'execute') auth,
              has_function_privilege('service_role', $1, 'execute') svc,
              p.prosecdef definer, p.proconfig cfg
         from pg_proc p where p.oid = $1::regprocedure`,
      [sig],
    );
    expect(r.rows[0]).toMatchObject({ anon: false, auth: false, svc: true, definer: false });
    expect(r.rows[0].cfg).toContain("search_path=public");

    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role anon");
      await expect(
        c.query(
          "select public.fn_carga_e_rodizio_dos_atendentes($1, $2::uuid[], $3::text[], null)",
          [ORG_A, [ANA], ["open"]],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("o índice do último evento por atendente existe", async () => {
    const r = await query(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'idx_cae_org_destino_recente'",
    );
    expect(r.rows[0]?.indexdef).toMatch(/\(organization_id, to_user_id, created_at DESC\)/);
  });
});

describe("o caminho real chega na contagem do banco", () => {
  it("roteamento: carga 1200 contra capacidade 1100 barra; o rodízio lê a última atribuição do canal", async () => {
    await query(
      `insert into public.attendant_availability (organization_id, user_id, is_available, capacity, schedule) values
         ($1, $2, true, 1100, '{}'), ($1, $3, true, 5, '{}')
       on conflict (organization_id, user_id) do update set is_available = true, capacity = excluded.capacity, schedule = '{}'`,
      [ORG_A, ANA, BRUNO],
    );
    const { client, errors } = routingPgSupabase(pool);
    const eleg = await loadEligibleAttendants(client, ORG_A, new Date(), {
      kind: "conversation_channel",
      channelSessionId: CANAL_A2,
    });
    expect(errors).toEqual([]);
    expect(eleg.map((c) => [c.userId, c.currentLoad, c.lastAssignedAt])).toEqual([
      [BRUNO, 3, minutos(-1440)],
    ]);
  });

  it("roster: a carga da tela Equipe é a do banco, não a que coube em 1000 linhas", async () => {
    const { client, errors } = routingPgSupabase(pool);
    const roster = await carregarRosterDeAtendimento(client, ORG_A, new Date());
    expect(errors).toEqual([]);
    expect(Object.fromEntries(roster.map((r) => [r.userId, r.cargaAtual]))).toEqual({
      [ANA]: 1200,
      [BRUNO]: 3,
    });
  });
});
