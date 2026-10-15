import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";

/**
 * /api/v1/setores — a borda: Zod antes do banco, manager+ para escrever,
 * organização sempre de requireRole, audit só com efeito.
 */
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireSupportWrite: vi.fn(async () => null),
}));

import { GET, POST } from "./route";
import { DELETE, PATCH } from "./[id]/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const MEMBRO = "44444444-4444-4444-8444-444444444444";
const SETOR = "55555555-5555-4555-8555-555555555555";

type Chamada = { table: string; op: string; values?: unknown; filtros: Array<[string, unknown]> };

function admin(resp: Partial<Record<string, { data?: unknown; error?: unknown }>> = {}) {
  const chamadas: Chamada[] = [];
  const from = (table: string) => {
    const c: Chamada = { table, op: "select", filtros: [] };
    chamadas.push(c);
    const r = () => resp[`${table}.${c.op}`] ?? { data: c.op === "select" ? [] : null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      insert: (v: unknown) => ((c.op = "insert"), (c.values = v), q),
      update: (v: unknown) => ((c.op = "update"), (c.values = v), q),
      delete: () => ((c.op = "delete"), q),
      upsert: (v: unknown) => ((c.op = "upsert"), (c.values = v), Promise.resolve({ error: null })),
      eq: (k: string, v: unknown) => (c.filtros.push([k, v]), q),
      order: () => q,
      single: () => Promise.resolve(r()),
      maybeSingle: () => Promise.resolve(r()),
      then: (ok: (x: unknown) => unknown) => Promise.resolve(r()).then(ok),
    };
    return q;
  };
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return chamadas;
}

function autorizado(role: "viewer" | "agent" | "manager" = "manager") {
  vi.mocked(requireRole).mockImplementation(async (min) => {
    const rank = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
    if (rank[role] < rank[min as keyof typeof rank]) {
      return { ok: false, response: fail("forbidden", "sem permissão", 403) } as never;
    }
    return {
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role },
    } as never;
  });
}

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/v1/setores", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id = SETOR) => ({ params: Promise.resolve({ id }) });

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/setores", () => {
  it("qualquer membro lê; a consulta filtra a organização da sessão", async () => {
    autorizado("viewer");
    const chamadas = admin({
      "setores.select": { data: [{ id: SETOR, nome: "Tributário", created_at: "x" }], error: null },
      "setor_membros.select": { data: [{ setor_id: SETOR, user_id: MEMBRO }], error: null },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ id: SETOR, nome: "Tributário", created_at: "x", membros: [MEMBRO] }]);
    expect(chamadas.every((c) => c.filtros.some(([k, v]) => k === "organization_id" && v === ORG))).toBe(true);
  });
});

describe("POST /api/v1/setores", () => {
  it("agent não cria (403) e nada toca o banco", async () => {
    autorizado("agent");
    const chamadas = admin();
    const res = await POST(req("POST", { nome: "Tributário" }));
    expect(res.status).toBe(403);
    expect(chamadas).toEqual([]);
  });

  it("organization_id no corpo é recusado (422), nunca usado", async () => {
    autorizado();
    const chamadas = admin();
    const res = await POST(req("POST", { nome: "Tributário", organization_id: OUTRA_ORG }));
    expect(res.status).toBe(422);
    expect(chamadas).toEqual([]);
  });

  it("cria com a organização da sessão, grava membros e audita", async () => {
    autorizado();
    const chamadas = admin({
      "setores.insert": { data: { id: SETOR, nome: "Tributário", created_at: "x" }, error: null },
    });
    const res = await POST(req("POST", { nome: " Tributário ", membros: [MEMBRO] }));
    expect(res.status).toBe(201);
    expect(chamadas.find((c) => c.table === "setores")?.values).toEqual({ organization_id: ORG, nome: "Tributário" });
    expect(chamadas.find((c) => c.table === "setor_membros" && c.op === "insert")?.values).toEqual([
      { organization_id: ORG, setor_id: SETOR, user_id: MEMBRO },
    ]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "setor.created", organizationId: ORG }));
  });

  it("nome repetido na organização → 409, sem audit", async () => {
    autorizado();
    admin({ "setores.insert": { data: null, error: { code: "23505" } } });
    const res = await POST(req("POST", { nome: "Tributário" }));
    expect(res.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });

  it("membro de outra organização (FK 23503) → 422 e o setor criado é desfeito", async () => {
    autorizado();
    const chamadas = admin({
      "setores.insert": { data: { id: SETOR, nome: "T", created_at: "x" }, error: null },
      "setor_membros.insert": { data: null, error: { code: "23503" } },
    });
    const res = await POST(req("POST", { nome: "T", membros: [MEMBRO] }));
    expect(res.status).toBe(422);
    expect(chamadas.some((c) => c.table === "setores" && c.op === "delete")).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acompanhamento somente-leitura barra antes de tudo", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(fail("support_readonly", "x", 403) as never);
    autorizado();
    const chamadas = admin();
    const res = await POST(req("POST", { nome: "T" }));
    expect(res.status).toBe(403);
    expect(chamadas).toEqual([]);
  });
});

describe("PATCH/DELETE /api/v1/setores/:id", () => {
  it("PATCH vazio é 422", async () => {
    autorizado();
    admin();
    expect((await PATCH(req("PATCH", {}), ctx())).status).toBe(422);
  });

  it("PATCH de setor de outra organização (não achado no filtro da sessão) → 404", async () => {
    autorizado();
    admin({ "setores.select": { data: null, error: null } });
    expect((await PATCH(req("PATCH", { nome: "X" }), ctx())).status).toBe(404);
  });

  it("PATCH substitui membros e audita", async () => {
    autorizado();
    admin({ "setores.select": { data: { id: SETOR }, error: null } });
    const res = await PATCH(req("PATCH", { membros: [MEMBRO] }), ctx());
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "setor.updated", resourceId: SETOR }));
  });

  it("DELETE filtra organização e id, e audita", async () => {
    autorizado();
    const chamadas = admin({ "setores.delete": { data: { id: SETOR }, error: null } });
    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(chamadas[0]?.filtros).toEqual([
      ["organization_id", ORG],
      ["id", SETOR],
    ]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "setor.deleted" }));
  });

  it("id que não é uuid → 400 antes do banco", async () => {
    autorizado();
    const chamadas = admin();
    expect((await DELETE(req("DELETE"), ctx("abc"))).status).toBe(400);
    expect(chamadas).toEqual([]);
  });
});
