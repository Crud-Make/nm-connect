/**
 * PROCESSOS NA TELA: a porta some sem o módulo, e o "Aprovar" é só de manager+.
 *
 *   1. `/app/processos` é módulo de TABELA (ADR-0002): sem a instalação, o layout chama
 *      `notFound()` — a tela não abre vazia nem quebra no primeiro fetch.
 *   2. Na ficha do contato o andamento em rascunho mostra "Aprovar" só a quem pode aprovar, e
 *      "Editar" só a quem escreve; o aprovado não oferece nenhum dos dois.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Andamento } from "@/lib/schemas/processos";

const mocks = vi.hoisted(() => ({
  moduloLigado: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  andamentos: [] as Andamento[],
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.moduloLigado }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/processos/useProcessos", () => ({
  useAndamentos: () => ({ data: mocks.andamentos, isLoading: false, isError: false }),
  useEscritaDeProcessos: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

import ProcessosLayout from "@/app/app/processos/layout";
import { AndamentosDoProcesso } from "@/components/contacts/AndamentosDoProcesso";

function andamento(status: Andamento["status"]): Andamento {
  return {
    id: `a-${status}`,
    processo_id: "p1",
    texto: `texto ${status}`,
    status,
    aprovado_em: status === "aprovado" ? "2026-10-20T12:00:00Z" : null,
    created_at: "2026-10-20T11:00:00Z",
  };
}

describe("layout de /app/processos", () => {
  beforeEach(() => {
    mocks.notFound.mockClear();
  });

  it("módulo não instalado: notFound, sem renderizar a tela", async () => {
    mocks.moduloLigado.mockResolvedValue(false);
    await expect(ProcessosLayout({ children: "tela" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.moduloLigado).toHaveBeenCalledWith(expect.anything(), "processos");
  });

  it("instalado: renderiza os filhos (controle positivo)", async () => {
    mocks.moduloLigado.mockResolvedValue(true);
    const r = await ProcessosLayout({ children: "tela" });
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).toContain("tela");
  });
});

describe("andamentos na ficha do contato", () => {
  beforeEach(() => {
    mocks.andamentos = [andamento("rascunho"), andamento("aprovado")];
  });

  it("manager vê Aprovar e Editar só no rascunho", () => {
    render(<AndamentosDoProcesso processoId="p1" podeEscrever podeAprovar />);
    expect(screen.getAllByRole("button", { name: "Aprovar" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Editar" })).toHaveLength(1);
    expect(screen.getByText("Rascunho")).toBeTruthy();
    expect(screen.getByText("Aprovado")).toBeTruthy();
  });

  it("agent edita e lança, mas não aprova", () => {
    render(<AndamentosDoProcesso processoId="p1" podeEscrever podeAprovar={false} />);
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lançar andamento" })).toBeTruthy();
  });

  it("viewer só lê: nenhum botão", () => {
    mocks.andamentos = [andamento("aprovado")];
    render(<AndamentosDoProcesso processoId="p1" podeEscrever={false} podeAprovar={false} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("texto aprovado")).toBeTruthy();
  });
});
