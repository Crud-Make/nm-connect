/**
 * Aba "Setores" de Equipe (migration 0675): lista os setores com os membros
 * pelo nome; só manager+ vê criar/editar/excluir (a API cobra o mesmo); e o
 * editor manda nome aparado + membros marcados.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { criar, setoresRef } = vi.hoisted(() => ({
  criar: vi.fn(),
  setoresRef: { current: undefined as unknown },
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/team/useAttendants", () => ({
  useAttendants: () => ({
    data: {
      data: [
        { user_id: "u-ana", name: "Ana", email: "ana@x.test", role: "agent" },
        { user_id: "u-bia", name: "Bia", email: "bia@x.test", role: "manager" },
        { user_id: "u-leitor", name: "Leitor", email: "l@x.test", role: "viewer" },
      ],
    },
  }),
}));
vi.mock("@/hooks/team/useSetores", () => ({
  useSetores: () => ({ data: setoresRef.current, isLoading: false }),
  useCriarSetor: () => ({ mutate: criar, isPending: false }),
  useAtualizarSetor: () => ({ mutate: vi.fn(), isPending: false }),
  useExcluirSetor: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { SetoresClient } from "./SetoresClient";

afterEach(() => {
  cleanup();
  criar.mockReset();
});

describe("SetoresClient", () => {
  it("lista os setores com os membros pelo nome", () => {
    setoresRef.current = { data: [{ id: "s1", nome: "Tributário", membros: ["u-ana"], created_at: "" }] };
    render(<SetoresClient canManage />);
    expect(screen.getByText("Tributário")).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
  });

  it("setor sem membros diz que não restringe", () => {
    setoresRef.current = { data: [{ id: "s1", nome: "Empresarial", membros: [], created_at: "" }] };
    render(<SetoresClient canManage />);
    expect(screen.getByText(/não restringe quem recebe/)).toBeInTheDocument();
  });

  it("quem não é manager não vê criar/editar/excluir", () => {
    setoresRef.current = { data: [{ id: "s1", nome: "Tributário", membros: [], created_at: "" }] };
    render(<SetoresClient canManage={false} />);
    expect(screen.queryByRole("button", { name: "Novo setor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Excluir setor" })).toBeNull();
  });

  it("criar: nome aparado + membros marcados; leitor (viewer) não é oferecido", () => {
    setoresRef.current = { data: [] };
    render(<SetoresClient canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Novo setor" }));
    expect(screen.queryByLabelText("Leitor")).toBeNull();
    fireEvent.change(screen.getByLabelText("Nome do setor"), { target: { value: "  Previdenciário " } });
    fireEvent.click(screen.getByLabelText("Bia"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(criar).toHaveBeenCalledWith({ nome: "Previdenciário", membros: ["u-bia"] }, expect.anything());
  });
});
