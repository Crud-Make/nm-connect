import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEligibleAttendants } from "./eligibles";
import { OPEN_LOAD_STATUSES } from "./eligibility";

/** O teto do PostgREST (`max_rows` em supabase/config.toml; o Supabase Cloud usa o mesmo). */
const MAX_ROWS = 1000;

type Conversa = {
  organization_id: string;
  assigned_to_user_id: string | null;
  status: string;
  channel_session_id: string;
};
type Evento = {
  organization_id: string;
  to_user_id: string | null;
  created_at: string;
  channel_session_id: string;
};

function fixture(over: Record<string, unknown> = {}) {
  const filters: Array<[string, string, unknown]> = [];
  const rpcs: Array<[string, Record<string, unknown>]> = [];
  const rows: Record<string, unknown> = {
    channel_sessions: { id: "channel" },
    channel_routing_policies: null,
    channel_routing_responsibles: [],
    user_organizations: [{ user_id: "ana" }],
    attendant_availability: [{ user_id: "ana", capacity: 2, schedule: {} }],
    conversations: [],
    conversation_assignment_events: [],
    ...over,
  };
  const db = {
    from(table: string) {
      const q = {
        select() {
          return q;
        },
        order() {
          return q;
        },
        eq(key: string, value: unknown) {
          filters.push([table, key, value]);
          return q;
        },
        is(key: string, value: unknown) {
          filters.push([table, key, value]);
          return q;
        },
        in(key: string, value: unknown) {
          filters.push([table, key, value]);
          return q;
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[table], error: null });
        },
        then(resolve: (x: unknown) => unknown) {
          const data = rows[table];
          // Leitura de linhas passa pelo corte silencioso do PostgREST: sem erro.
          return Promise.resolve(
            data instanceof Error
              ? { data: null, error: data }
              : { data: Array.isArray(data) ? data.slice(0, MAX_ROWS) : data, error: null },
          ).then(resolve);
        },
      };
      return q;
    },
    // A contagem no banco: vê TODAS as linhas, como um count/distinct on no Postgres.
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push([name, args]);
      if (rows.rpcError instanceof Error)
        return Promise.resolve({ data: null, error: rows.rpcError });
      const org = args.p_organization_id as string;
      const users = args.p_user_ids as string[];
      const statuses = args.p_statuses as string[];
      const channel = (args.p_channel_session_id as string | null) ?? null;
      const conversas = rows.conversations as Conversa[];
      const eventos = rows.conversation_assignment_events as Evento[];
      const data = users.map((user_id) => {
        const carga = conversas.filter(
          (c) =>
            c.organization_id === org &&
            c.assigned_to_user_id === user_id &&
            statuses.includes(c.status),
        ).length;
        const ultima =
          eventos
            .filter(
              (e) =>
                e.organization_id === org &&
                e.to_user_id === user_id &&
                (channel === null || e.channel_session_id === channel),
            )
            .map((e) => e.created_at)
            .sort()
            .at(-1) ?? null;
        return { user_id, carga, ultima_atribuicao_em: ultima };
      });
      return Promise.resolve({ data, error: null });
    },
  } as unknown as SupabaseClient;
  return { db, filters, rpcs };
}
const scope = { kind: "conversation_channel", channelSessionId: "channel" } as const;
const now = new Date("2026-09-06T15:00:00Z");
describe("elegibilidade com origem explícita", () => {
  it("política vazia não cai no conjunto legado", async () => {
    const { db } = fixture({ channel_routing_policies: { id: "policy" } });
    expect(await loadEligibleAttendants(db, "org", now, scope)).toEqual([]);
  });
  it("membro revogado não recebe mesmo com disponibilidade legada", async () => {
    const { db } = fixture({ user_organizations: [] });
    expect(await loadEligibleAttendants(db, "org", now, scope)).toEqual([]);
  });
  it("capacidade é global e histórico é apenas do canal, com org na contagem", async () => {
    const { db, rpcs } = fixture();
    expect(await loadEligibleAttendants(db, "org", now, scope)).toMatchObject([{ userId: "ana" }]);
    expect(rpcs).toEqual([
      [
        "fn_carga_e_rodizio_dos_atendentes",
        {
          p_organization_id: "org",
          p_user_ids: ["ana"],
          p_statuses: [...OPEN_LOAD_STATUSES],
          p_channel_session_id: "channel",
        },
      ],
    ]);
  });
  it("resumo global não consulta política nem filtra histórico por canal", async () => {
    const { db, filters, rpcs } = fixture();
    await loadEligibleAttendants(db, "org", now, { kind: "organization_summary" });
    expect(filters.some(([table]) => table === "channel_routing_policies")).toBe(false);
    expect(rpcs[0]?.[1]).toMatchObject({ p_channel_session_id: null });
  });
  it("canal inexistente não autoriza fallback", async () => {
    const { db } = fixture({ channel_sessions: null });
    await expect(loadEligibleAttendants(db, "org", now, scope)).rejects.toThrow(
      "routing_channel_invalid",
    );
  });
  it("erro de banco não vira sem elegível", async () => {
    const { db } = fixture({ attendant_availability: new Error("offline") });
    await expect(loadEligibleAttendants(db, "org", now, scope)).rejects.toThrow("offline");
  });
  it("erro na contagem de carga não vira carga zero", async () => {
    const { db } = fixture({ rpcError: new Error("count offline") });
    await expect(loadEligibleAttendants(db, "org", now, scope)).rejects.toThrow("count offline");
  });
});

describe("carga e rodízio sem o corte de 1000 linhas do PostgREST", () => {
  it("com 1200 conversas abertas, a carga é 1200 e o teto de capacidade barra", async () => {
    // Capacidade 1100: lida em linhas, a carga seria 1000 (o corte) e a ana
    // entraria como elegível com folga que ela não tem.
    const conversations: Conversa[] = Array.from({ length: 1200 }, () => ({
      organization_id: "org",
      assigned_to_user_id: "ana",
      status: "claimed",
      channel_session_id: "channel",
    }));
    const { db } = fixture({
      attendant_availability: [{ user_id: "ana", capacity: 1100, schedule: {} }],
      conversations,
    });
    expect(await loadEligibleAttendants(db, "org", now, scope)).toEqual([]);
  });

  it("menor carga vê a carga inteira de cada um, não a que coube nas 1000 linhas", async () => {
    // 1100 da ana chegam primeiro; as 50 do bruno ficariam além do corte, e o
    // bruno pareceria ter carga 0.
    const conversations: Conversa[] = [
      ...Array.from({ length: 1100 }, () => ({
        organization_id: "org",
        assigned_to_user_id: "ana",
        status: "open",
        channel_session_id: "channel",
      })),
      ...Array.from({ length: 50 }, () => ({
        organization_id: "org",
        assigned_to_user_id: "bruno",
        status: "open",
        channel_session_id: "channel",
      })),
    ];
    const { db } = fixture({
      user_organizations: [{ user_id: "ana" }, { user_id: "bruno" }],
      attendant_availability: [
        { user_id: "ana", capacity: 5000, schedule: {} },
        { user_id: "bruno", capacity: 5000, schedule: {} },
      ],
      conversations,
    });
    const got = await loadEligibleAttendants(db, "org", now, scope);
    expect(got.map((c) => [c.userId, c.currentLoad])).toEqual([
      ["ana", 1100],
      ["bruno", 50],
    ]);
  });

  it("com mais de 1000 eventos, a última atribuição de quem ficou além do corte não some", async () => {
    // 1000 eventos mais novos da ana preenchem o corte; o único evento do
    // bruno é mais velho e, lido em linhas, ele pareceria nunca ter recebido.
    const base = Date.parse("2026-09-01T00:00:00Z");
    const conversation_assignment_events: Evento[] = [
      ...Array.from({ length: 1000 }, (_, i) => ({
        organization_id: "org",
        to_user_id: "ana",
        channel_session_id: "channel",
        created_at: new Date(base + (i + 10) * 60_000).toISOString(),
      })).reverse(),
      {
        organization_id: "org",
        to_user_id: "bruno",
        channel_session_id: "channel",
        created_at: new Date(base).toISOString(),
      },
    ];
    const { db } = fixture({
      user_organizations: [{ user_id: "ana" }, { user_id: "bruno" }],
      attendant_availability: [
        { user_id: "ana", capacity: 5, schedule: {} },
        { user_id: "bruno", capacity: 5, schedule: {} },
      ],
      conversation_assignment_events,
    });
    const got = await loadEligibleAttendants(db, "org", now, scope);
    expect(got.find((c) => c.userId === "bruno")?.lastAssignedAt).toBe(base);
    expect(got.find((c) => c.userId === "ana")?.lastAssignedAt).toBe(base + 1009 * 60_000);
  });
});
