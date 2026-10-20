/**
 * PEDIR O TELEFONE — o botão nativo REQUEST_CONTACT_INFO da Cloud API.
 *
 * Quem chega por username (só BSUID, sem telefone) pode ser atendido e
 * respondido pelo BSUID; o que não dá é o que depende do NÚMERO — consultar
 * processo pelo telefone, cruzar com a base do escritório, mandar pelo canal
 * por QR. O caminho que a Meta documenta para isso é um botão: a pessoa toca,
 * o número dela é compartilhado na conversa, e o webhook chega como
 * `type: "contacts"` com `origin: "contact_request"` — que a ingestão já junta
 * à ficha do BSUID (`telefoneInformado`, migration 0678).
 *
 * Fonte: developers.facebook.com/documentation/business-messaging/whatsapp/
 * business-scoped-user-ids, seção "Como solicitar o número de telefone dos
 * usuários" (atualizada em 15/09/2026). O botão não aceita personalização
 * nenhuma: o corpo é só o texto e a ação.
 *
 * ─── Interativo, e por isso DENTRO da janela de 24h ─────────────────────────
 *
 * Fora da janela o mesmo botão só sai dentro de um modelo `utility`/`marketing`
 * aprovado com um botão `REQUEST_CONTACT_INFO` — esse caminho é o do envio de
 * modelo que já existe (`send-template.ts`) e não precisa de código aqui. Esta
 * função não confere a janela: quem chama passa pela cadeia `before_send`, que
 * é onde a janela é regra (doutrina `restricao-de-canal.md`).
 */
import { destinatarioDaGraph } from "./bsuid";

export function pedirTelefonePayload(destinatario: string, texto: string): Record<string, unknown> {
  const corpo = texto.trim();
  if (corpo === "") {
    throw new Error("pedir_telefone_sem_texto: a Meta exige o texto do corpo da mensagem interativa.");
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...destinatarioDaGraph(destinatario),
    type: "interactive",
    interactive: {
      type: "request_contact_info",
      body: { text: corpo },
      action: { name: "request_contact_info" },
    },
  };
}
