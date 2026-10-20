/**
 * A etiqueta "Grupo" na lista de conversas.
 *
 * `conversations.is_group` já chega no `SELECT_COLS` do handler (schema
 * original) — este teste prende só a LEITURA na tela: quem abre o inbox
 * precisa distinguir uma conversa de grupo de uma individual sem abrir cada
 * uma. Props mínimas copiadas de `ConversationList.tsx`, via
 * `__fixtures__/conversa.ts`.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "./ConversationListItem";
import { conversaDeExemplo } from "./__fixtures__/conversa";

describe("ConversationListItem — etiqueta de grupo", () => {
  it("conversa de grupo tem a etiqueta Grupo", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: true }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByText("Grupo")).toBeInTheDocument();
  });

  it("conversa individual não tem", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: false }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByText("Grupo")).toBeNull();
  });
});

/**
 * A bolinha no canto do avatar. A cor sai de quem está no comando, mas cor
 * sozinha não se explica — a palavra vem junto, no `title` e no nome acessível.
 */
describe("ConversationListItem — bolinha de quem atende", () => {
  it("a bolinha do avatar diz em palavras quem está no comando", () => {
    render(
      <ConversationListItem
        conversation={{
          ...conversaDeExemplo.conversation,
          assigned_to_user_id: "user-1",
          assigned_to_user_name: "Ana",
          assignee_kind: "user",
        }}
        {...conversaDeExemplo.props}
      />,
    );
    const bolinha = screen.getByRole("img", { name: "Em atendimento" });
    expect(bolinha).toHaveAttribute("title", "Em atendimento");
  });

  it("conversa encerrada: a bolinha diz Encerrada", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, status: "closed" }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByRole("img", { name: "Encerrada" })).toHaveAttribute("title", "Encerrada");
  });

  // O caminho comum da aba de fechadas: alguém assumiu e fechou. Fechar não solta
  // o dono (`fn_service_status`), e `comandoDaConversa` segue dizendo `humano` de
  // propósito — mas a PALAVRA "Em atendimento" afirmaria um atendimento que acabou.
  it("conversa encerrada COM dono: a bolinha diz Encerrada, nunca Em atendimento", () => {
    render(
      <ConversationListItem
        conversation={{
          ...conversaDeExemplo.conversation,
          status: "closed",
          assigned_to_user_id: "user-1",
          assigned_to_user_name: "Ana",
          assignee_kind: "user",
        }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByRole("img", { name: "Encerrada" })).toHaveAttribute("title", "Encerrada");
    expect(screen.queryByRole("img", { name: "Em atendimento" })).toBeNull();
  });
});

/**
 * O setor da conversa (migration 0675). É o que torna a espera visível: uma
 * conversa do Tributário parada na Fila diz DE QUEM ela está esperando.
 */
describe("ConversationListItem — setor", () => {
  it("conversa com setor mostra o nome do setor", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, setor_id: "s-trib" }}
        {...conversaDeExemplo.props}
        nomeDoSetor="Tributário"
      />,
    );
    expect(screen.getByText("Tributário")).toBeInTheDocument();
    expect(screen.getByTitle("Setor Tributário")).toBeInTheDocument();
  });

  it("sem setor, nenhum selo de setor", () => {
    render(<ConversationListItem conversation={conversaDeExemplo.conversation} {...conversaDeExemplo.props} />);
    expect(screen.queryByTitle(/^Setor /)).toBeNull();
  });
});

/**
 * Quem chegou pelo WhatsApp oficial com username, sem telefone (migration
 * 0678). A linha da lista não pode cair em "Sem nome" nem mostrar o BSUID
 * cru: o @username é como a pessoa aparece no WhatsApp dela.
 */
describe("ConversationListItem — contato sem telefone (username do WhatsApp)", () => {
  const semTelefone = (extra: Record<string, unknown>) => ({
    ...conversaDeExemplo.conversation,
    contacts: {
      ...conversaDeExemplo.conversation.contacts!,
      name: null,
      display_name: null,
      phone_number: null,
      wa_bsuid: "US.13491208655302741918",
      ...extra,
    },
  });

  it("mostra o @username", () => {
    render(
      <ConversationListItem conversation={semTelefone({ wa_username: "realsheenanelson" })} {...conversaDeExemplo.props} />,
    );
    expect(screen.getByText("@realsheenanelson")).toBeInTheDocument();
    expect(screen.queryByText("US.13491208655302741918")).toBeNull();
  });

  it("sem username: 'Cliente sem telefone', nunca o BSUID", () => {
    render(<ConversationListItem conversation={semTelefone({ wa_username: null })} {...conversaDeExemplo.props} />);
    expect(screen.getByText("Cliente sem telefone")).toBeInTheDocument();
    expect(screen.queryByText(/US\.1349/)).toBeNull();
  });
});
