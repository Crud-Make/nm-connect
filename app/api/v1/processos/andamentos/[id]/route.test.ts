/**
 * PATCH /api/v1/processos/andamentos/[id] — editar o texto do andamento.
 *
 * Passa SEMPRE pela `fn_processos_andamento_editar` (migration 0707): é a única porta que
 * reescreve um aprovado, e a reescrita o devolve a rascunho na mesma linha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
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

const CAMINHO = `/api/v1/processos/andamentos/${ANDAMENTO_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH andamento", () => {
  it("agent edita pela rpc, na organização ativa, e audita só ids", async () => {
    autorizadoComo("agent");
    const { rpcs } = bancoFalso({
      data: { id: ANDAMENTO_ID, processo_id: PROCESSO_ID, status: "rascunho" },
      error: null,
    });

    const { PATCH } = await import("./route");
    const res = await PATCH(pedido(CAMINHO, "PATCH", { texto: "Texto novo." }), comId(ANDAMENTO_ID));

    expect(res.status).toBe(200);
    expect(rpcs).toEqual([
      {
        nome: "fn_processos_andamento_editar",
        args: { p_org: ORG_ID, p_id: ANDAMENTO_ID, p_texto: "Texto novo." },
      },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "andamento.editado",
        resourceId: ANDAMENTO_ID,
        metadata: { processo_id: PROCESSO_ID },
      }),
    );
  });

  it("viewer NÃO edita", async () => {
    negado();
    const { PATCH } = await import("./route");
    expect((await PATCH(pedido(CAMINHO, "PATCH", { texto: "x" }), comId(ANDAMENTO_ID))).status).toBe(403);
  });

  it("andamento de outra organização ou inexistente → 404", async () => {
    autorizadoComo("agent");
    bancoFalso({ data: null, error: { code: "P0002", message: "andamento_nao_encontrado" } });

    const { PATCH } = await import("./route");
    const res = await PATCH(pedido(CAMINHO, "PATCH", { texto: "x" }), comId(ANDAMENTO_ID));

    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("módulo não instalado (42P01 dentro da função) → 409", async () => {
    autorizadoComo("agent");
    bancoFalso({ data: null, error: { code: "42P01" } });

    const { PATCH } = await import("./route");
    expect((await PATCH(pedido(CAMINHO, "PATCH", { texto: "x" }), comId(ANDAMENTO_ID))).status).toBe(409);
  });
});
