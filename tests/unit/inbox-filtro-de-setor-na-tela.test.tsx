/**
 * O seletor "Setor" da inbox (migration 0675), pela tela.
 *
 * Sem setor na organização, o seletor não existe (a tela de sempre). Com
 * setores, ele aparece; e um filtro de setor que continua ligado depois de o
 * setor ser excluído segue visível como "Setor removido" — sem isso a lista
 * ficaria num recorte vazio sem nada dizendo por quê (a mesma válvula do canal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";

const setoresRef: { current: unknown } = { current: undefined };
const contagemRef: { current: unknown } = { current: undefined };

vi.mock("@/hooks/team/useSetores", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useSetores: () => ({ data: setoresRef.current }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" } }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({ useConversationTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: (_org: unknown, filtros: unknown) => {
    contagemRef.current = filtros;
    return { data: { unassigned: 0, mine: 0, all: 0 } };
  },
}));

const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };
const SETOR = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  setoresRef.current = undefined;
  contagemRef.current = undefined;
});
afterEach(cleanup);

describe("seletor de setor na inbox", () => {
  it("organização sem setor: o seletor não aparece", () => {
    setoresRef.current = { data: [] };
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.queryByRole("combobox", { name: "Filtrar por setor" })).toBeNull();
  });

  it("com setores: o seletor aparece em 'Todos os setores'", () => {
    setoresRef.current = { data: [{ id: SETOR, nome: "Tributário", membros: [], created_at: "" }] };
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Filtrar por setor" })).toHaveTextContent("Todos os setores");
  });

  it("filtro ligado: o seletor nomeia o setor e o badge conta o mesmo recorte", () => {
    setoresRef.current = { data: [{ id: SETOR, nome: "Tributário", membros: [], created_at: "" }] };
    render(<InboxFilters value={{ ...VALUE, setor_id: SETOR }} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Filtrar por setor" })).toHaveTextContent("Tributário");
    expect(contagemRef.current).toMatchObject({ setor_id: SETOR });
  });

  it("setor excluído com o filtro ligado: o seletor fica, como 'Setor removido'", () => {
    setoresRef.current = { data: [] };
    render(<InboxFilters value={{ ...VALUE, setor_id: SETOR }} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Filtrar por setor" })).toHaveTextContent("Setor removido");
  });
});
