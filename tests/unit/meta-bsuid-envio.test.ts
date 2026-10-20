import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O ENVIO PARA QUEM NÃO TEM TELEFONE — `recipient: "<BSUID>"`.
 *
 * A doc da Meta (business-scoped-user-ids, 15/09/2026) aceita o BSUID no campo
 * `recipient` do mesmo `POST /{phone_number_id}/messages`; com `to` e
 * `recipient` juntos vale `to`. A regra daqui é a mais estreita: telefone vai
 * em `to` como sempre, e o BSUID só é o endereço quando o contato NÃO tem
 * telefone — a resposta da IA, a da Inbox, o follow-up e a automação saem
 * todos por `resolveRecipient` + `send`/`sendTemplate`, então é aqui que os
 * quatro passam a alcançar o lead que veio por username.
 */
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/meta/credentials", () => ({
  resolveMetaCreds: async () => ({ phoneNumberId: "106540352242922", token: "tok", graphVersion: "v22.0" }),
  metaCredsFromEnv: () => null,
}));

import { metaCloudAdapter } from "@/lib/channels/adapters/meta-cloud";
import { pedirTelefonePayload } from "@/lib/channels/meta/pedir-telefone";
import { sendTemplate } from "@/lib/channels/meta/send-template";

const BSUID = "US.13491208655302741918";

let spy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    // A resposta de envio por BSUID, como a doc a mostra.
    json: async () => ({
      messaging_product: "whatsapp",
      contacts: [{ input: BSUID, user_id: BSUID }],
      messages: [{ id: "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA" }],
    }),
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

const corpoEnviado = () => JSON.parse(spy.mock.calls[0]![1].body as string) as Record<string, unknown>;

describe("resolveRecipient — quem é o endereço", () => {
  const base = { isGroup: false, groupChatId: null, waIdentity: null };

  it("com telefone: os dígitos, como sempre — mesmo que haja BSUID", () => {
    expect(
      metaCloudAdapter.resolveRecipient({ ...base, phoneNumber: "+55 31 99999-0001", waBsuid: BSUID }),
    ).toBe("5531999990001");
  });

  it("⭐ sem telefone e com BSUID: o BSUID", () => {
    expect(metaCloudAdapter.resolveRecipient({ ...base, phoneNumber: null, waBsuid: BSUID })).toBe(BSUID);
  });

  it("sem telefone e sem BSUID: null (o chamador grava missing_phone_number, como antes)", () => {
    expect(metaCloudAdapter.resolveRecipient({ ...base, phoneNumber: null })).toBeNull();
    expect(metaCloudAdapter.resolveRecipient({ ...base, phoneNumber: null, waBsuid: "lixo" })).toBeNull();
  });

  it("grupo continua null", () => {
    expect(
      metaCloudAdapter.resolveRecipient({ ...base, isGroup: true, phoneNumber: null, waBsuid: BSUID }),
    ).toBeNull();
  });
});

describe("send — o campo do corpo", () => {
  const envelope = { organizationId: "org-1", sessionRef: "106540352242922", kind: "text" as const, body: "Oi!" };

  it("⭐ endereço BSUID sai em `recipient`, sem `to`", async () => {
    const r = await metaCloudAdapter.send({ ...envelope, to: BSUID });
    expect(r.externalId).toMatch(/^wamid\./);
    const corpo = corpoEnviado();
    expect(corpo).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      recipient: BSUID,
      type: "text",
      text: { body: "Oi!" },
    });
    expect(corpo).not.toHaveProperty("to");
  });

  it("endereço telefone sai em `to`, sem `recipient` — comportamento de antes", async () => {
    await metaCloudAdapter.send({ ...envelope, to: "5531999990001" });
    const corpo = corpoEnviado();
    expect(corpo).toMatchObject({ to: "5531999990001" });
    expect(corpo).not.toHaveProperty("recipient");
  });
});

describe("sendTemplate — o follow-up fora da janela também alcança o BSUID", () => {
  const CURRENT = {
    name: "retomada",
    language: "pt_BR",
    contractHash: "h",
    status: "APPROVED",
    components: [{ type: "BODY", text: "Olá! Podemos continuar?" }],
  };
  const BINDING = { name: "retomada", language: "pt_BR", contractHash: "h", values: {} };
  const BASE = { phoneNumberId: "106540352242922", token: "tok", graphVersion: "v22.0" };

  it("⭐ BSUID em `recipient`", async () => {
    const r = await sendTemplate({ ...BASE, to: BSUID, binding: BINDING, current: CURRENT });
    expect(r.sent).toBe(true);
    const corpo = corpoEnviado();
    expect(corpo).toMatchObject({ recipient: BSUID, type: "template" });
    expect(corpo).not.toHaveProperty("to");
  });

  it("telefone em `to`, como antes", async () => {
    await sendTemplate({ ...BASE, to: "5531999990001", binding: BINDING, current: CURRENT });
    const corpo = corpoEnviado();
    expect(corpo).toMatchObject({ to: "5531999990001" });
    expect(corpo).not.toHaveProperty("recipient");
  });
});

describe("pedir o telefone — o botão REQUEST_CONTACT_INFO (interativo, dentro da janela)", () => {
  it("o corpo é o da doc: interactive.type = request_contact_info, sem parâmetro", () => {
    expect(pedirTelefonePayload(BSUID, "Para consultar seu processo, toque no botão e compartilhe seu número.")).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      recipient: BSUID,
      type: "interactive",
      interactive: {
        type: "request_contact_info",
        body: { text: "Para consultar seu processo, toque no botão e compartilhe seu número." },
        action: { name: "request_contact_info" },
      },
    });
  });

  it("texto vazio é recusado antes da rede — a Meta exige o corpo", () => {
    expect(() => pedirTelefonePayload(BSUID, "   ")).toThrow(/texto/);
  });

  it("⭐ o adapter expõe a capacidade, e ela sai pela Graph com o BSUID", async () => {
    expect(typeof metaCloudAdapter.requestContactInfo).toBe("function");
    const r = await metaCloudAdapter.requestContactInfo!({
      organizationId: "org-1",
      sessionRef: "106540352242922",
      recipient: BSUID,
      body: "Pode compartilhar seu número?",
    });
    expect(r.externalId).toMatch(/^wamid\./);
    expect(spy.mock.calls[0]![0]).toContain("/106540352242922/messages");
    expect(corpoEnviado()).toMatchObject({ recipient: BSUID, type: "interactive" });
  });
});
