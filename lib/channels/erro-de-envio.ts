/**
 * Falha de envio JÁ CLASSIFICADA pelo canal — o vocabulário que atravessa o seam.
 *
 * O handler de mensagens não pode ramificar por provider (invariante 1 da
 * doutrina de restrição de canal), mas precisa saber três coisas que só quem lê
 * a resposta crua sabe:
 *
 *   - **incerta** — o transporte não respondeu a tempo. Abortar a espera NÃO
 *     prova que a mensagem não saiu: o pedido pode ter chegado e a resposta ter
 *     se perdido. Reenviar aqui é arriscar mandar duas vezes, e envio em dobro é
 *     pior que não-envio. Fica `failed`, marcada, e NINGUÉM reenvia sozinho.
 *   - **credencial** — a plataforma disse que a chave de acesso não vale
 *     (vencida, revogada). Não é defeito desta mensagem: é a conexão inteira
 *     parada, e alguém precisa ver isso na tela.
 *   - **temporaria** — a plataforma recusou por limite de vazão ANTES de aceitar
 *     a mensagem (não há id dela do outro lado). Tentar de novo depois é seguro.
 *   - **permanente** — o resto: recusa que repetir não resolve.
 *
 * `codigo` é o que vai para `messages.error_code` e CARREGA nome de provider —
 * por isso nasce dentro de `lib/channels/`, como `adapter.codes`. Quem chama
 * grava o que o canal disser, sem interpretar.
 *
 * `message` preserva o formato de antes (`<prefixo>_<código>: <detalhe>`): é o
 * texto que o operador já lia em `error_message`, e o detalhe da plataforma é
 * às vezes a única pista real.
 */
export type NaturezaDaFalhaDeEnvio = "incerta" | "credencial" | "temporaria" | "permanente";

export class ErroDeEnvioDoCanal extends Error {
  override readonly name = "ErroDeEnvioDoCanal";
  constructor(
    readonly codigo: string,
    readonly natureza: NaturezaDaFalhaDeEnvio,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/**
 * Chave em `messages.metadata` da mensagem cujo desfecho é desconhecido
 * (natureza `incerta`). É ela que o ledger do agente lê para NÃO abrir uma
 * tentativa nova sobre uma mensagem que pode ter chegado ao cliente — ver
 * `lib/agent-engine/edge/crm/send-ledger.ts`.
 */
export const METADATA_ENTREGA_INCERTA = "entrega_incerta";
