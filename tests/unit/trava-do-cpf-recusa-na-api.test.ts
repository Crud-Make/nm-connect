import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A TRAVA DO CPF É RECUSADA NA API sem a chave do cliente por telefone (#18).
 *
 * Duas camadas, e cada uma pega o que a outra não vê: o Zod recusa o corpo que
 * liga a trava junto com uma chave errada (sem ir ao banco); o CHECK da 0676
 * recusa o PATCH parcial que liga a trava numa conexão SEM chave — e a rota tem
 * de traduzir o 23514 em 422 com a frase da tela, nunca em 500.
 */
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn().mockResolvedValue(null) }));
vi.mock("@/app/api/v1/external-db/_falha", () => ({ seModuloDesligado: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn().mockResolvedValue({
    ok: true,
    user: { id: "user-1", idioma: "pt-BR" },
    org: { orgId: "org-1" },
  }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/external-db/conexao", () => ({ fecharPool: vi.fn() }));
vi.mock("@/lib/external-db/guardas", () => ({
  validarHostDeBanco: vi.fn().mockResolvedValue({ ok: true, enderecos: ["203.0.114.1"] }),
}));
vi.mock("@/lib/external-db/credenciais", () => ({ cifrarSenha: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const resultadoDoBanco = { data: null as unknown, error: null as unknown };
const patches: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const chain = {
      update: (p: Record<string, unknown>) => {
        patches.push(p);
        return chain;
      },
      insert: (p: Record<string, unknown>) => {
        patches.push(p);
        return chain;
      },
      eq: () => chain,
      select: () => chain,
      maybeSingle: async () => resultadoDoBanco,
      single: async () => resultadoDoBanco,
    };
    return { from: () => chain };
  },
}));

const { PATCH } = await import("@/app/api/v1/external-db/connections/[id]/route");
const { POST } = await import("@/app/api/v1/external-db/connections/route");

function pedido(corpo: unknown) {
  return new Request("http://local/api/v1/external-db/connections/x", {
    method: "PATCH",
    body: JSON.stringify(corpo),
  }) as never;
}
const ctx = { params: Promise.resolve({ id: "conn-1" }) };

beforeEach(() => {
  patches.length = 0;
  resultadoDoBanco.data = null;
  resultadoDoBanco.error = null;
});

describe("PATCH /external-db/connections/:id — trava do CPF", () => {
  it("ligar junto com chave por e-mail: 422 do Zod, sem ir ao banco", async () => {
    const r = await PATCH(
      pedido({ require_cpf_check: true, customer_key_column: "email", customer_key_kind: "email" }),
      ctx,
    );
    expect(r.status).toBe(422);
    expect(patches).toHaveLength(0);
  });

  it("ligar numa conexão sem chave: o CHECK do banco (23514) vira 422 com a frase da tela", async () => {
    resultadoDoBanco.error = { code: "23514", message: "violates check constraint" };
    const r = await PATCH(pedido({ require_cpf_check: true }), ctx);
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message).toContain("telefone");
    expect(patches[0]).toEqual({ require_cpf_check: true });
  });

  it("controle: ligar com a chave por telefone grava", async () => {
    resultadoDoBanco.data = { id: "conn-1", require_cpf_check: true };
    const r = await PATCH(
      pedido({ require_cpf_check: true, customer_key_column: "telefone", customer_key_kind: "phone" }),
      ctx,
    );
    expect(r.status).toBe(200);
    expect(patches[0]).toMatchObject({ require_cpf_check: true, customer_key_kind: "phone" });
  });
});

describe("POST /external-db/connections — trava do CPF", () => {
  const BASE = {
    label: "Processos",
    host: "db.exemplo.com",
    database_name: "processos",
    username: "crm_leitor",
    password: "segredo",
  };

  it("criar com a trava e sem chave: 422 do Zod", async () => {
    const r = await POST(pedido({ ...BASE, require_cpf_check: true }));
    expect(r.status).toBe(422);
    expect(patches).toHaveLength(0);
  });

  it("criar sem dizer nada: a trava nasce desligada", async () => {
    resultadoDoBanco.data = { id: "conn-1" };
    const r = await POST(pedido(BASE));
    expect(r.status).toBe(201);
    expect(patches[0]).toMatchObject({ require_cpf_check: false });
  });
});
