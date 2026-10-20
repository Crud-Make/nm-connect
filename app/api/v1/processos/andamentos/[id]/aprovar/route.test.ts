/**
 * POST /api/v1/processos/andamentos/[id]/aprovar — só o aprovado chega ao cliente.
 *
 * Exige `manager` e passa pela `fn_processos_andamento_aprovar` (migration 0707), que grava quem
 * aprovou, quando e o sha256 do texto da linha travada. Aprovar duas vezes é recusado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  ANDAMENTO_ID,
  ORG_ID,
  PROCESSO_ID,
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

const CAMINHO = `/api/v1/processos/andamentos/${ANDAMENTO_ID}/aprovar`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST aprovar", () => {
  it("manager aprova pela rpc e audita só ids", async () => {
    autorizadoComo("manager");
    const { rpcs } = bancoFalso({
      data: { id: ANDAMENTO_ID, processo_id: PROCESSO_ID, status: "aprovado" },
      error: null,
    });

    const { POST } = await import("./route");
    const res = await POST(pedido(CAMINHO, "POST"), comId(ANDAMENTO_ID));

    expect(res.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
    expect(rpcs).toEqual([
      { nome: "fn_processos_andamento_aprovar", args: { p_org: ORG_ID, p_id: ANDAMENTO_ID } },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "andamento.aprovado",
        resourceId: ANDAMENTO_ID,
        metadata: { processo_id: PROCESSO_ID },
      }),
    );
  });

  it("abaixo de manager → 403 de requireRole", async () => {
    negado();
    const { POST } = await import("./route");
    expect((await POST(pedido(CAMINHO, "POST"), comId(ANDAMENTO_ID))).status).toBe(403);
  });

  it("já aprovado → 422 e sem audit", async () => {
    autorizadoComo("manager");
    bancoFalso({ data: null, error: { code: "22023", message: "andamento_ja_aprovado" } });

    const { POST } = await import("./route");
    const res = await POST(pedido(CAMINHO, "POST"), comId(ANDAMENTO_ID));

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/já está aprovado/);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a função recusa o papel (processos_forbidden) → 403", async () => {
    autorizadoComo("manager");
    bancoFalso({ data: null, error: { code: "42501", message: "processos_forbidden" } });

    const { POST } = await import("./route");
    expect((await POST(pedido(CAMINHO, "POST"), comId(ANDAMENTO_ID))).status).toBe(403);
  });
});
