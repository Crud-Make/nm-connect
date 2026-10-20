/**
 * A FICHA DO CONTATO TROCA AS ABAS DO TOPO POR UM MENU LATERAL DE SEÇÕES.
 *
 *   1. As seções saem de UMA lista (`lib/contacts/secoes-da-ficha.ts`): Processos só com o módulo
 *      ligado (decidido no servidor), LGPD só para admin — e todo rótulo fala espanhol.
 *   2. A seção ativa vive em `?secao=`: valor desconhecido ou de seção escondida cai na primeira,
 *      como `?aba=` em Conexões. O link da seção ativa leva `aria-current`.
 *   3. O ☰ recolhe e abre o menu no desktop (lembrado no navegador) e abre a gaveta no celular.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MenuDeSecoes } from "@/components/contacts/MenuDeSecoes";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { SECOES_DA_FICHA, secaoAtiva, secoesDaFicha } from "@/lib/contacts/secoes-da-ficha";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const ids = (secoes: { id: string }[]) => secoes.map((s) => s.id);

describe("lista de seções da ficha", () => {
  it("sem módulo e sem admin: só Visão geral e Timeline", () => {
    expect(ids(secoesDaFicha({ processosAtivo: false, isAdmin: false }))).toEqual([
      "visao-geral",
      "timeline",
    ]);
  });

  it("módulo processos ligado e admin: Processos e LGPD entram, na ordem da lista", () => {
    expect(ids(secoesDaFicha({ processosAtivo: true, isAdmin: true }))).toEqual([
      "visao-geral",
      "processos",
      "timeline",
      "lgpd",
    ]);
  });

  it("todo rótulo da lista tem espanhol no dicionário", () => {
    const semEspanhol = SECOES_DA_FICHA.filter((s) => !DICIONARIO[s.rotulo]?.es).map((s) => s.rotulo);
    expect(semEspanhol).toEqual([]);
  });
});

describe("seção ativa pela URL", () => {
  const semModulo = secoesDaFicha({ processosAtivo: false, isAdmin: false });
  const comModulo = secoesDaFicha({ processosAtivo: true, isAdmin: false });

  it("sem parâmetro: a primeira seção", () => {
    expect(secaoAtiva(null, semModulo)).toBe("visao-geral");
  });

  it("parâmetro de seção visível: ela", () => {
    expect(secaoAtiva("timeline", semModulo)).toBe("timeline");
    expect(secaoAtiva("processos", comModulo)).toBe("processos");
  });

  it("seção escondida ou desconhecida: a primeira, nunca tela vazia", () => {
    expect(secaoAtiva("processos", semModulo)).toBe("visao-geral");
    expect(secaoAtiva("lgpd", comModulo)).toBe("visao-geral");
    expect(secaoAtiva("qualquer", semModulo)).toBe("visao-geral");
  });
});

function abrirMenu(ativa = "timeline") {
  return render(
    <MenuDeSecoes
      contactId="c-1"
      secoes={secoesDaFicha({ processosAtivo: true, isAdmin: false })}
      ativa={ativa}
      cabecalho={<h1>Thygass</h1>}
    >
      <p>conteúdo da seção</p>
    </MenuDeSecoes>,
  );
}

const menuFixo = () => screen.queryByRole("navigation", { name: "Seções do contato" });

describe("menu lateral", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("links apontam para ?secao= e só a ativa tem aria-current", () => {
    abrirMenu("timeline");
    const nav = within(menuFixo()!);
    expect(nav.getByRole("link", { name: "Visão geral" })).toHaveAttribute("href", "/app/contacts/c-1");
    const timeline = nav.getByRole("link", { name: "Timeline" });
    expect(timeline).toHaveAttribute("href", "/app/contacts/c-1?secao=timeline");
    expect(timeline).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Processos" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("conteúdo da seção")).toBeInTheDocument();
  });

  it("☰ recolhe e abre o menu fixo, e a escolha sobrevive a uma nova visita", () => {
    const { unmount } = abrirMenu();
    const botao = screen.getByRole("button", { name: "Recolher seções do contato" });
    expect(botao).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(botao);
    expect(menuFixo()).toBeNull();
    const reabrir = screen.getByRole("button", { name: "Mostrar seções do contato" });
    expect(reabrir).toHaveAttribute("aria-expanded", "false");
    // O conteúdo não some com o menu.
    expect(screen.getByText("conteúdo da seção")).toBeInTheDocument();
    unmount();

    abrirMenu();
    expect(menuFixo()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar seções do contato" }));
    expect(menuFixo()).not.toBeNull();
  });

  it("storage bloqueado: o ☰ continua funcionando", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    abrirMenu();
    fireEvent.click(screen.getByRole("button", { name: "Recolher seções do contato" }));
    expect(menuFixo()).toBeNull();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("celular: o ☰ abre a gaveta com as seções, e escolher uma fecha a gaveta", () => {
    abrirMenu();
    fireEvent.click(screen.getByRole("button", { name: "Abrir seções do contato" }));
    const gaveta = screen.getByRole("dialog");
    const link = within(gaveta).getByRole("link", { name: "Processos" });
    expect(link).toHaveAttribute("href", "/app/contacts/c-1?secao=processos");
    fireEvent.click(link);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
