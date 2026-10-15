import { describe, expect, it } from "vitest";

import { carimbosDeEntrega, soSeMaisAntigo, statusUpdate } from "./status-update";
import type { MessageStatusEvent } from "./webhook";

const AGORA = "2026-09-21T12:00:00.000Z";

function evento(over: Partial<MessageStatusEvent>): MessageStatusEvent {
  return {
    kind: "message_status",
    wabaId: "waba-1",
    externalId: "wamid.HBg",
    status: "sent",
    recipient: "5571992894634",
    errorCode: null,
    errorTitle: null,
    occurredAt: null,
    ...over,
  };
}

describe("statusUpdate", () => {
  it("guarda o motivo quando a Meta reprova a entrega", () => {
    const u = statusUpdate(
      evento({ status: "failed", errorCode: 131026, errorTitle: "Message Undeliverable" }),
      AGORA,
    );
    expect(u.status).toBe("failed");
    expect(u.error_code).toBe("131026");
    expect(u.error_message).toBe("Message Undeliverable");
  });

  it("carimba entrega e leitura em vez de achatar tudo em sent", () => {
    expect(statusUpdate(evento({ status: "delivered" }), AGORA)).toEqual({
      status: "sent",
      updated_at: AGORA,
    });
    expect(carimbosDeEntrega(evento({ status: "delivered" }), AGORA)).toEqual([
      { coluna: "delivered_at", em: AGORA },
    ]);
    expect(carimbosDeEntrega(evento({ status: "read" }), AGORA)).toEqual([
      { coluna: "delivered_at", em: AGORA },
      { coluna: "read_at", em: AGORA },
    ]);
  });

  it("o carimbo é a hora do EVENTO da Meta, não a hora em que o webhook chegou", () => {
    // Reentrega horas depois carimbaria a hora da reentrega.
    const quando = new Date("2026-09-21T09:15:00.000Z");
    expect(carimbosDeEntrega(evento({ status: "read", occurredAt: quando }), AGORA)).toEqual([
      { coluna: "delivered_at", em: "2026-09-21T09:15:00.000Z" },
      { coluna: "read_at", em: "2026-09-21T09:15:00.000Z" },
    ]);
  });

  it("o filtro só deixa o carimbo andar para TRÁS (nulo ou posterior ao evento)", () => {
    expect(soSeMaisAntigo({ coluna: "read_at", em: AGORA })).toBe(
      `read_at.is.null,read_at.gt."${AGORA}"`,
    );
  });

  it("não inventa carimbo nem erro no sent cru", () => {
    const u = statusUpdate(evento({ status: "sent" }), AGORA);
    expect(u).toEqual({ status: "sent", updated_at: AGORA });
    expect(carimbosDeEntrega(evento({ status: "sent" }), AGORA)).toEqual([]);
  });
});
