/**
 * GET/POST /api/v1/processos — módulo opcional de advocacia (ADR-0002, migration 0707).
 *
 * Ler exige `viewer`; cadastrar exige `agent` (a mesma RLS de `processos`). Tabela ausente
 * (módulo não instalado: 42P01 no Postgres, PGRST205 pelo PostgREST) vira 409 claro, nunca 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import {
  CONTATO_ID,
  ORG_ID,
  autorizadoComo,
  bancoFalso,
  negado,
  pedido,
} from "@/tests/helpers/rota-de-processos";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const CORPO = { contact_id: CONTATO_ID, apelido: "Divórcio", area: "familia" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/processos", () => {
  it("viewer lê os processos do contato, filtrados pela organização ativa", async () => {
    autorizadoComo("viewer");
    const { filtros } = bancoFalso({ data: [{ id: "p1" }], error: null });

    const { GET } = await import("./route");
    const res = await GET(pedido(`/api/v1/processos?contact_id=${CONTATO_ID}`));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ id: "p1" }]);
    expect(filtros).toContainEqual({ coluna: "organization_id", valor: ORG_ID });
    expect(filtros).toContainEqual({ coluna: "contact_id", valor: CONTATO_ID });
  });

  it("sem contact_id lista os processos da organização (a tela /app/processos)", async () => {
    autorizadoComo("viewer");
    const { filtros } = bancoFalso({ data: [], error: null });

    const { GET } = await import("./route");
    const res = await GET(pedido("/api/v1/processos"));

    expect(res.status).toBe(200);
    expect(filtros.map((f) => f.coluna)).toEqual(["organization_id"]);
  });

  it("contact_id que não é uuid → 422, sem ir ao banco", async () => {
    autorizadoComo("viewer");
    const { client } = bancoFalso({ data: [], error: null });

    const { GET } = await import("./route");
    const res = await GET(pedido("/api/v1/processos?contact_id=abc"));

    expect(res.status).toBe(422);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("sem papel → repassa o 403 de requireRole", async () => {
    negado();
    const { GET } = await import("./route");
    expect((await GET(pedido("/api/v1/processos"))).status).toBe(403);
  });

  it.each(["42P01", "PGRST205"])("módulo não instalado (%s) → 409 module_not_installed", async (code) => {
    autorizadoComo("viewer");
    bancoFalso({ data: null, error: { code } });

    const { GET } = await import("./route");
    const res = await GET(pedido("/api/v1/processos"));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("module_not_installed");
    expect(body.error.message).toMatch(/módulo de processos não está instalado/);
  });
});

describe("POST /api/v1/processos", () => {
  it("agent cadastra o processo na organização ativa e audita só ids", async () => {
    autorizadoComo("agent");
    const { inserts } = bancoFalso({ data: { id: "p1", contact_id: CONTATO_ID }, error: null });

    const { POST } = await import("./route");
    const res = await POST(pedido("/api/v1/processos", "POST", CORPO));

    expect(res.status).toBe(200);
    expect(inserts[0]).toMatchObject({ organization_id: ORG_ID, contact_id: CONTATO_ID, fase: "conhecimento" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "processo.criado",
        resourceId: "p1",
        metadata: { contact_id: CONTATO_ID },
      }),
    );
  });

  it("viewer NÃO cadastra — escrita exige agent+", async () => {
    negado();
    const { POST } = await import("./route");
    expect((await POST(pedido("/api/v1/processos", "POST", CORPO))).status).toBe(403);
  });

  it("número CNJ fora do formato → 422, nunca chega ao banco", async () => {
    autorizadoComo("agent");
    const { client } = bancoFalso({ data: null, error: null });

    const { POST } = await import("./route");
    const res = await POST(pedido("/api/v1/processos", "POST", { ...CORPO, numero_cnj: "123" }));

    expect(res.status).toBe(422);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("contato de outra organização (FK composta, 23503) → 422 e sem audit", async () => {
    autorizadoComo("agent");
    bancoFalso({ data: null, error: { code: "23503" } });

    const { POST } = await import("./route");
    const res = await POST(pedido("/api/v1/processos", "POST", CORPO));

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Contato inválido/);
    expect(audit).not.toHaveBeenCalled();
  });

  it("número CNJ repetido na organização (23505) → 422", async () => {
    autorizadoComo("agent");
    bancoFalso({ data: null, error: { code: "23505" } });

    const { POST } = await import("./route");
    const res = await POST(pedido("/api/v1/processos", "POST", CORPO));

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/número CNJ/);
  });
});
