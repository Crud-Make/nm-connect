/**
 * BSUID — o id do usuário no escopo da empresa (Business-Scoped User ID).
 *
 * Quem adota username no WhatsApp pode chegar SEM telefone: a Meta omite
 * `from`/`wa_id`/`to`/`recipient_id` quando a empresa não falou com aquele
 * número nos últimos 30 dias (contados por número da empresa) e a pessoa não
 * tem o número da empresa nos contatos. A identidade que sempre vem é o BSUID
 * (`from_user_id`, `user_id`, `recipient_user_id`, `to_user_id`), e é por ele
 * que se responde: `recipient: "<BSUID>"` no lugar de `to`.
 *
 * Fonte: developers.facebook.com/documentation/business-messaging/whatsapp/
 * business-scoped-user-ids (atualizada em 15/09/2026, lida em 20/10/2026).
 *
 * ─── O formato, tal como a doc o descreve ───────────────────────────────────
 *
 * Código de país ISO 3166 alfa-2, um ponto, e até 128 caracteres
 * alfanuméricos — até 131 no total (`US.13491208655302741918`). Tem de ser
 * usado INTEIRO: mudar o prefixo ou o ponto faz o envio falhar.
 *
 * O parent BSUID (`US.ENT.…`, só para empresas gerenciadas que se inscrevem)
 * NÃO casa aqui de propósito: o que o CRM guarda é a identidade do portfólio,
 * a única que todo cliente tem.
 *
 * ─── A hipótese que este módulo assume ──────────────────────────────────────
 *
 * O BSUID é único por PORTFÓLIO + usuário. O CRM o guarda único por
 * ORGANIZAÇÃO (`contacts.wa_bsuid`, migration 0678), o que pressupõe uma
 * organização com números de UM portfólio só. Uma organização com números de
 * dois portfólios veria a mesma pessoa com dois BSUIDs: o segundo não casa com
 * o primeiro, e quem chega só por ele vira outro contato — a ficha fica
 * duplicada, nunca misturada com a de outra pessoa.
 */

/** O formato da doc: `XX.` + até 128 alfanuméricos. */
const FORMATO_DO_BSUID = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;

/** O valor É um BSUID no formato da doc? */
export function ehBsuid(valor: string): boolean {
  return FORMATO_DO_BSUID.test(valor);
}

/**
 * BSUID lido de um campo do payload (ou de uma coluna), ou `null`.
 *
 * Fora do formato vale como ausente — nunca como identidade "quase certa":
 * guardar um valor que a API recusa faria o contato nascer com um endereço
 * para o qual nenhuma resposta sai.
 */
export function bsuidOuNull(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const v = valor.trim();
  return v !== "" && ehBsuid(v) ? v : null;
}

/**
 * Como o destinatário entra no corpo do `POST /{phone_number_id}/messages`.
 *
 * Telefone vai em `to` (dígitos E.164, como sempre); BSUID vai em
 * `recipient`. A doc aceita os dois juntos e, nesse caso, vale `to` — por isso
 * quem tem telefone nunca chega aqui com BSUID: `resolveRecipient` só devolve
 * o BSUID quando o contato NÃO tem telefone.
 */
export function destinatarioDaGraph(endereco: string): { to: string } | { recipient: string } {
  return ehBsuid(endereco) ? { recipient: endereco } : { to: endereco };
}
