/**
 * Mensagem com desfecho DESCONHECIDO não ganha tentativa nova do agente.
 *
 * O ledger abre uma intenção nova (rotaciona a chave) quando a mensagem anterior
 * terminou `failed` — e o retry do job reenvia. Isso é certo para recusa
 * explícita, e errado para o tempo esgotado: a plataforma pode ter recebido o
 * pedido e só a resposta ter se perdido. Ali a linha carrega
 * `metadata.entrega_incerta`, e o ledger NÃO rotaciona nem chama o canal.
 */
import { expect, it, vi } from "vitest";

import { sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";

type Store = Parameters<typeof sendWithLedger>[0];
const intent = { tenantId: "org", leadId: "contact", jobId: "job", seq: 1, body: "Olá" };

function store(message: { id: string; status: string; entregaIncerta?: boolean } | null): Store {
  return {
    create: vi.fn(async () => {
      throw { code: "23505" };
    }),
    find: vi.fn(async () => ({
      id: "ledger-original",
      status: "failed" as const,
      crm_message_id: message?.id ?? null,
    })),
    rotate: vi.fn(async () => "ledger-novo"),
    message: vi.fn(async () => message),
    update: vi.fn(async () => {}),
  };
}

it("failed com entrega incerta: não rotaciona, não chama o canal, devolve failed", async () => {
  const db = store({ id: "ledger-original", status: "failed", entregaIncerta: true });
  const send = vi.fn();

  const r = await sendWithLedger(db, intent, send);

  expect(r).toEqual({
    kind: "failed",
    idempotencyKey: "ledger-original",
    crmMessageId: "ledger-original",
  });
  expect(db.rotate).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("controle: failed por recusa explícita continua abrindo tentativa nova", async () => {
  const db = store({ id: "ledger-original", status: "failed" });
  const send = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));

  expect((await sendWithLedger(db, intent, send)).kind).toBe("sent");
  expect(db.rotate).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith("ledger-novo", "ledger-novo");
});
