/**
 * `statuses[]` da Cloud API → colunas da linha de `messages`.
 *
 * Existe porque a rota do webhook gravava só `status: failed | sent` e jogava
 * fora o resto do evento. O estrago aparece quando o template é ACEITO pela
 * Meta (a chamada volta 200 com `wamid`, a linha nasce `sent`) e a entrega
 * falha depois: o motivo vem em `statuses[0].errors[0]` — 131026 número não
 * registrado, 131047 fora da janela sem template, 131049 limite de marketing,
 * 132015 template pausado — e nenhum deles chegava ao operador. A tela dizia
 * "enviado" para uma mensagem que nunca tocou o aparelho, e não havia onde
 * olhar.
 *
 * `delivered` e `read` também se perdiam: viravam `sent`, e `delivered_at` /
 * `read_at` ficavam nulos para sempre neste canal. O canal não-oficial já
 * grava os dois (`lib/waha/ingest.ts`, `handleAck`); a assimetria era o defeito,
 * não o desenho.
 *
 * `status` continua colapsado em `sent | failed` de propósito: é o domínio que
 * o resto do produto lê. A informação fina vai para as colunas que já existem.
 *
 * ── Ordem e reentrega ────────────────────────────────────────────────────────
 *
 * A Meta reentrega tudo o que não recebe 2xx e não garante ordem entre
 * `sent`/`delivered`/`read`/`failed`. Duas consequências, e as duas viraram
 * defeito quando o update era um só, sem guarda:
 *
 *   1. um `delivered` atrasado depois de um `failed` reabria a mensagem como
 *      `sent` — a tela voltava a dizer "enviado" para o que a Meta recusou. A
 *      guarda `status <> 'failed'` mora na ROTA, no update de cada carimbo.
 *   2. `delivered_at`/`read_at` eram a HORA DE RECEBIMENTO: cada reentrega
 *      empurrava o carimbo para frente. Agora o carimbo é a hora do EVENTO
 *      (`occurredAt`, o `timestamp` da Meta) e só anda para TRÁS: grava quando
 *      a coluna é nula ou quando o evento é mais antigo do que o que está lá.
 *
 * Por que "o mais antigo" e não "só se nulo": `read` implica entregue e carimba
 * `delivered_at` também. Se o `read` chega antes do `delivered` (fora de ordem),
 * "só se nulo" congelaria a hora da LEITURA como hora de entrega. O mínimo é o
 * valor certo nos dois casos, e é idempotente: reentregar o mesmo evento grava
 * o mesmo instante, ou nada.
 */
import type { MessageStatusEvent } from "./webhook";

/**
 * As colunas que o evento sobrescreve sem condição de tempo: `status`,
 * `updated_at` e, na falha, o motivo. Os carimbos ficam em `carimbosDeEntrega`
 * porque cada um tem a sua própria condição.
 */
export function statusUpdate(e: MessageStatusEvent, now: string): Record<string, unknown> {
  const update: Record<string, unknown> = {
    status: e.status === "failed" ? "failed" : "sent",
    updated_at: now,
  };

  if (e.status === "failed") {
    // `error_code` é texto no banco (o canal não-oficial grava rótulos ali).
    update.error_code = e.errorCode === null ? null : String(e.errorCode);
    update.error_message = e.errorTitle;
  }

  return update;
}

export interface CarimboDeEntrega {
  coluna: "delivered_at" | "read_at";
  /** ISO-8601 UTC — a hora do evento, ou `now` quando a Meta não mandou. */
  em: string;
}

/**
 * Os carimbos que o evento propõe. Quem grava aplica cada um SÓ se a coluna
 * estiver nula ou guardar um instante posterior (ver o cabeçalho).
 */
export function carimbosDeEntrega(e: MessageStatusEvent, now: string): CarimboDeEntrega[] {
  const em = e.occurredAt ? e.occurredAt.toISOString() : now;
  // `read` implica entregue — a Meta não manda `delivered` garantido antes.
  if (e.status === "read") {
    return [
      { coluna: "delivered_at", em },
      { coluna: "read_at", em },
    ];
  }
  if (e.status === "delivered") return [{ coluna: "delivered_at", em }];
  return [];
}

/**
 * O filtro PostgREST "nulo ou posterior a `em`" — a metade do `.or()` que faz
 * o carimbo só andar para trás. O valor vai entre aspas duplas porque `.` e `:`
 * são reservados na árvore lógica do PostgREST, e um ISO-8601 tem os dois.
 */
export function soSeMaisAntigo(c: CarimboDeEntrega): string {
  return `${c.coluna}.is.null,${c.coluna}.gt."${c.em}"`;
}
