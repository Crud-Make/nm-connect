/**
 * GET/POST /api/v1/processos/[id]/andamentos.
 *
 * Ler exige `viewer`, e o que cada papel vê é da RLS (viewer só o aprovado, agent+ todos).
 * Lançar exige `agent` e nasce sempre rascunho: aprovar é outra rota, de manager+.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import {
  ORG_ID,
  PROCESSO_ID,
  USER_ID,
  autorizadoComo,
  bancoFalso,
  comId,
  negado,
  pedido,
} from "@/tests/helpers/rota-de-processos";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const CAMINHO = `/api/v1/processos/${PROCESSO_ID}/andamentos`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET andamentos", () => {
  it("viewer lê os andamentos do processo na organização ativa", async () => {
    autorizadoComo("viewer");
    const { filtros } = bancoFalso({ data: [{ id: "a1", status: "aprovado" }], error: null });

    const { GET } = await import("./route");
    const res = await GET(pedido(CAMINHO), comId(PROCESSO_ID));

    expect(res.status).toBe(200);
    expect(filtros).toContainEqual({ coluna: "organization_id", valor: ORG_ID });
    expect(filtros).toContainEqual({ coluna: "processo_id", valor: PROCESSO_ID });
  });

  it("módulo não instalado → 409", async () => {
    autorizadoComo("viewer");
    bancoFalso({ data: null, error: { code: "PGRST205" } });

    const { GET } = await import("./route");
    expect((await GET(pedido(CAMINHO), comId(PROCESSO_ID))).status).toBe(409);
  });
});

describe("POST andamentos", () => {
  it("agent lança o rascunho com quem escreveu, e audita só ids", async () => {
    autorizadoComo("agent");
    const { inserts } = bancoFalso({ data: { id: "a1", processo_id: PROCESSO_ID }, error: null });

    const { POST } = await import("./route");
    const res = await POST(pedido(CAMINHO, "POST", { texto: "  Audiência marcada.  " }), comId(PROCESSO_ID));

    expect(res.status).toBe(200);
    expect(inserts[0]).toEqual({
      organization_id: ORG_ID,
      processo_id: PROCESSO_ID,
      texto: "Audiência marcada.",
      criado_por: USER_ID,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "andamento.criado",
        resourceId: "a1",
        metadata: { processo_id: PROCESSO_ID },
      }),
    );
  });

  it("viewer NÃO lança andamento", async () => {
    negado();
    const { POST } = await import("./route");
    expect((await POST(pedido(CAMINHO, "POST", { texto: "x" }), comId(PROCESSO_ID))).status).toBe(403);
  });

  it("texto vazio → 422, sem ir ao banco", async () => {
    autorizadoComo("agent");
    const { client } = bancoFalso({ data: null, error: null });

    const { POST } = await import("./route");
    const res = await POST(pedido(CAMINHO, "POST", { texto: "   " }), comId(PROCESSO_ID));

    expect(res.status).toBe(422);
    expect(client.from).not.toHaveBeenCalled();
  });

  it.each(["23503", "42501"])("processo de outra organização (%s) → 422 e sem audit", async (code) => {
    autorizadoComo("agent");
    bancoFalso({ data: null, error: { code } });

    const { POST } = await import("./route");
    const res = await POST(pedido(CAMINHO, "POST", { texto: "x" }), comId(PROCESSO_ID));

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Processo inválido/);
    expect(audit).not.toHaveBeenCalled();
  });
});
