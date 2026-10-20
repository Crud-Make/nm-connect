import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CPF DIGITADO NA EDIÇÃO É GRAVADO OU RECUSADO — NUNCA DESCARTADO.
 *
 * Sem a `cpf_key` em `private.app_secrets`, `encrypt_cpf` falha e
 * `camposCpfParaGravar` devolve `{}`. No create isso é a degradação da #2522 (a
 * importação não perde a linha). Na edição o CPF é o pedido de quem digitou: o
 * PATCH respondia "Contato atualizado" com o CPF jogado fora, ou "Nenhum campo
 * para atualizar" quando ele era o único campo. A trava de Processos (0706)
 * depende desse CPF, e o contato que chegou pelo WhatsApp só o ganha por aqui.
 */

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ORG = "c0f00000-0000-4000-8000-000000000001";
const CONTATO = "c0f00000-0000-4000-8000-0000000000c1";
const CPF = "529.982.247-25";

let cifra: { data: unknown; error: { message: string } | null };
let gravado: Record<string, unknown> | null;

function cliente(): unknown {
  const linha = { id: CONTATO, organization_id: ORG, is_anonymized: false, tags: [], consent: {} };
  const encadeia = (fim: () => unknown) => {
    const c: Record<string, unknown> = {};
    c.eq = () => c;
    c.select = () => c;
    c.maybeSingle = async () => ({ data: fim(), error: null });
    return c;
  };
  return {
    from: () => ({
      select: () => encadeia(() => linha),
      update: (patch: Record<string, unknown>) => {
        gravado = patch;
        return encadeia(() => ({ ...linha, ...patch }));
      },
    }),
    rpc: async (nome: string) => (nome === "encrypt_cpf" ? cifra : { data: null, error: null }),
  };
}

async function editar(input: Record<string, unknown>) {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  return patchContactHandler(
    cliente() as never,
    { organization_id: ORG, actor: { type: "user", id: "u1" }, requestId: "req-cpf" },
    CONTATO,
    input as never,
  );
}

beforeEach(() => {
  gravado = null;
});

describe("PATCH de contato com CPF", () => {
  it("com a cifra disponível, grava o PAR hash + texto cifrado", async () => {
    cifra = { data: "\\x0102", error: null };
    await editar({ cpf: CPF });
    expect(gravado?.cpf_encrypted).toBe("\\x0102");
    expect(gravado?.cpf_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sem a chave, recusa com 503 e não grava nada — nem os outros campos", async () => {
    cifra = { data: null, error: { message: "CPF_ENCRYPTION_KEY ausente" } };
    await expect(editar({ cpf: CPF, name: "Novo" })).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
    });
    expect(gravado, "o UPDATE não pode sair com o CPF descartado").toBeNull();
  });
});
