import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  parseMetaWebhook,
  type InboundMessageEvent,
  type InboundSemIdentidadeEvent,
  type MessageStatusEvent,
  type OutboundEchoEvent,
} from "@/lib/channels/meta/webhook";

/**
 * USERNAMES DO WHATSAPP — o parser do canal oficial com o BSUID.
 *
 * ═══ O DEFEITO ═══
 *
 * Quem adota username no WhatsApp passa a chegar SEM telefone: a Meta omite
 * `messages[].from` quando a empresa não falou com aquele número nos últimos 30
 * dias e a pessoa não tem o número da empresa nos contatos — o caso de TODO
 * lead novo que vem de anúncio ou Instagram. A identidade vem em
 * `from_user_id` (o BSUID). O parser fazia `if (!id || !from) continue`: a
 * mensagem não virava contato, nem conversa, nem lead, e a IA não acordava.
 * Nada na Central, nada no log.
 *
 * ═══ AS FIXTURES SÃO DA DOC, NÃO MINHAS ═══
 *
 * `tests/fixtures/meta/bsuid-da-doc.json` são os exemplos da página oficial
 * "IDs do usuário no escopo da empresa" (atualizada em 15/09/2026), com os
 * marcadores trocados pelos valores concretos que a própria página usa. Mock
 * escrito por quem escreve o parser concorda com ele por construção.
 *
 * A doc corrigiu em 2026 o que dizia antes: o campo ausente é OMITIDO, não
 * string vazia. Os dois formatos são tratados — um payload antigo reentregue
 * não pode voltar a sumir.
 */
const DOC = JSON.parse(readFileSync("tests/fixtures/meta/bsuid-da-doc.json", "utf8")) as Record<
  string,
  Parameters<typeof parseMetaWebhook>[0]
>;
const REAIS = JSON.parse(
  readFileSync("tests/fixtures/meta/inbound-webhooks.json", "utf8"),
) as Parameters<typeof parseMetaWebhook>[0][];

const BSUID = "US.13491208655302741918";

const clonar = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const recebidas = (env: Parameters<typeof parseMetaWebhook>[0]) =>
  parseMetaWebhook(env).filter((e): e is InboundMessageEvent => e.kind === "inbound_message");

/** A primeira mensagem do payload, para mexer nela sem tocar no arquivo. */
function primeiraMensagem(env: Parameters<typeof parseMetaWebhook>[0]): Record<string, unknown> {
  const v = env!.entry![0]!.changes![0]!.value as { messages: Record<string, unknown>[] };
  return v.messages[0]!;
}

describe("os três casos de identidade da mensagem recebida", () => {
  it("o payload REAL de 2026-07-29 já trazia o BSUID ao lado do telefone", () => {
    // Medido na WABA de teste: `from_user_id` e `contacts[].user_id` já vinham
    // (`BR.` + dígitos), e ninguém lia. É a prova de que o formato da doc é o
    // que chega de verdade — e de que o caso "telefone + BSUID" não é teórico.
    const [e] = recebidas(REAIS[0]!);
    expect(e).toMatchObject({ from: "553198966398", fromUserId: "BR.2222239905247480" });
  });

  it("só telefone (formato anterior aos usernames): continua como sempre, sem chave nova", () => {
    const env = clonar(REAIS[0]!);
    delete primeiraMensagem(env).from_user_id;
    const [e] = recebidas(env);
    expect(e).toMatchObject({ from: "553198966398", profileName: "Contato Teste" });
    // Sem BSUID no payload, nenhuma chave nova nasce no evento: quem compara o
    // evento inteiro (toEqual) segue verde, e o caminho de ingestão é o antigo.
    expect(e).not.toHaveProperty("fromUserId");
    expect(e).not.toHaveProperty("username");
  });

  it("telefone + BSUID: leva os dois, e o username do bloco contacts", () => {
    const [e] = recebidas(DOC.mensagem_telefone_e_bsuid!);
    expect(e).toMatchObject({
      kind: "inbound_message",
      from: "16505551234",
      fromUserId: BSUID,
      username: "realsheenanelson",
      profileName: "Sheena Nelson",
      phoneNumberId: "106540352242922",
      type: "text",
      text: "Does it come in another color?",
    });
  });

  it("⭐ só BSUID (`from` omitido): a mensagem NÃO some — vira evento com a identidade", () => {
    const eventos = recebidas(DOC.mensagem_so_bsuid!);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      from: null,
      fromUserId: BSUID,
      username: "realsheenanelson",
      // O perfil é achado pelo `user_id` do bloco contacts — não há `wa_id`.
      profileName: "Sheena Nelson",
      text: "Does it come in another color?",
    });
  });

  it("só BSUID com `from: \"\"` (formato que a doc usava antes de 2026): mesmo desfecho", () => {
    const env = clonar(DOC.mensagem_so_bsuid!);
    primeiraMensagem(env).from = "";
    const [e] = recebidas(env);
    expect(e).toMatchObject({ from: null, fromUserId: BSUID });
  });

  it("o parent BSUID NÃO é a identidade guardada — `from_parent_user_id` é ignorado", () => {
    // Só quem é gerenciado e se inscreveu tem parent BSUID; a identidade do
    // contato no CRM é a do portfólio (`from_user_id`). Ver `lib/channels/meta/bsuid.ts`.
    const [e] = recebidas(DOC.mensagem_so_bsuid!);
    expect(e!.fromUserId).toBe(BSUID);
    expect(JSON.stringify(e)).not.toContain("US.ENT.");
  });
});

describe("mensagem sem NENHUMA identidade", () => {
  it("não vira mensagem — vira o evento `inbound_sem_identidade`, para alguém ver", () => {
    const env = clonar(DOC.mensagem_so_bsuid!);
    delete primeiraMensagem(env).from_user_id;
    const eventos = parseMetaWebhook(env);
    expect(eventos.filter((e) => e.kind === "inbound_message")).toHaveLength(0);
    const [aviso] = eventos.filter(
      (e): e is InboundSemIdentidadeEvent => e.kind === "inbound_sem_identidade",
    );
    expect(aviso).toMatchObject({
      phoneNumberId: "106540352242922",
      externalId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
      type: "text",
    });
  });

  it("BSUID fora do formato da doc conta como ausente (e o aviso aparece)", () => {
    const env = clonar(DOC.mensagem_so_bsuid!);
    primeiraMensagem(env).from_user_id = "<BSUID>";
    const eventos = parseMetaWebhook(env);
    expect(eventos.map((e) => e.kind)).toEqual(["inbound_sem_identidade"]);
  });

  it("sem `id` continua caindo fora calado: não há o que reprocessar nem nomear", () => {
    const env = clonar(DOC.mensagem_so_bsuid!);
    delete primeiraMensagem(env).id;
    expect(parseMetaWebhook(env)).toEqual([]);
  });
});

describe("o telefone que chega pelo botão REQUEST_CONTACT_INFO", () => {
  it("`contacts` com origin=contact_request: o telefone vira `telefoneInformado`", () => {
    const [e] = recebidas(DOC.contatos_request_contact_info!);
    expect(e).toMatchObject({
      from: null,
      fromUserId: BSUID,
      type: "contact",
      telefoneInformado: "16505551234",
    });
  });

  it("cartão compartilhado à mão (origin=other) NÃO é o telefone de quem mandou", () => {
    // A pessoa pode compartilhar o contato de um terceiro. Só o toque no botão
    // de pedido de contato prova que o número é DELA.
    const env = clonar(DOC.contatos_request_contact_info!);
    const cartao = (primeiraMensagem(env).contacts as Record<string, unknown>[])[0]!;
    cartao.origin = "other";
    const [e] = recebidas(env);
    expect(e).not.toHaveProperty("telefoneInformado");
    expect(e!.sharedContact?.phone_number).toBeTruthy();
  });
});

describe("status e eco com BSUID", () => {
  it("status entregue leva `recipient_user_id`", () => {
    const [s] = parseMetaWebhook(DOC.status_entregue!).filter(
      (e): e is MessageStatusEvent => e.kind === "message_status",
    );
    expect(s).toMatchObject({
      status: "delivered",
      recipient: "16505551234",
      recipientUserId: BSUID,
    });
  });

  it("status enviado por BSUID sem `recipient_id`: o evento não se perde", () => {
    const env = clonar(DOC.status_entregue!);
    const v = env!.entry![0]!.changes![0]!.value as { statuses: Record<string, unknown>[] };
    delete v.statuses[0]!.recipient_id;
    const [s] = parseMetaWebhook(env).filter(
      (e): e is MessageStatusEvent => e.kind === "message_status",
    );
    expect(s).toMatchObject({ recipient: null, recipientUserId: BSUID });
  });

  it("status `failed` da doc (sem bloco contacts) segue igual", () => {
    const [s] = parseMetaWebhook(DOC.status_falhou!).filter(
      (e): e is MessageStatusEvent => e.kind === "message_status",
    );
    expect(s).toMatchObject({ status: "failed", recipient: "16505551234", errorCode: 131049 });
    expect(s).not.toHaveProperty("recipientUserId");
  });

  it("eco do app com `to` omitido e `to_user_id`: entra pelo BSUID, com o username", () => {
    const env = clonar(DOC.eco_smb!);
    const v = env!.entry![0]!.changes![0]!.value as { message_echoes: Record<string, unknown>[] };
    delete v.message_echoes[0]!.to;
    const [eco] = parseMetaWebhook(env).filter(
      (e): e is OutboundEchoEvent => e.kind === "outbound_echo",
    );
    expect(eco).toMatchObject({
      to: null,
      toUserId: BSUID,
      username: "realsheenanelson",
      text: "Oi! Tem sim.",
    });
  });

  it("eco com telefone e BSUID (payload da doc): leva os dois", () => {
    const [eco] = parseMetaWebhook(DOC.eco_smb!).filter(
      (e): e is OutboundEchoEvent => e.kind === "outbound_echo",
    );
    expect(eco).toMatchObject({ to: "16505551234", toUserId: BSUID });
  });
});
