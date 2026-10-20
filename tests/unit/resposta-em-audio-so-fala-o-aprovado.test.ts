/**
 * A RESPOSTA EM NOTA DE VOZ SÓ FALA O QUE A CADEIA `before_send` APROVOU.
 *
 * A lógica mora em `lib/messaging/voz/` e é testada lá, por comportamento. O
 * que este arquivo prende é a FIAÇÃO dentro do `execute` do `send_message`, que
 * é uma closure do turno sem ponto de injeção barato (mesma técnica de
 * `send-message-manda-foto-do-produto.test.ts`):
 *
 *  1. chave e teto são resolvidos ANTES da cadeia (fora do lock do número);
 *  2. a síntese acontece DENTRO do `send` que o guardrail chama, com o
 *     `finalBody` — nunca com o `body` cru do modelo;
 *  3. o custo e o motivo são gravados DEPOIS da cadeia (fora do lock: um insert
 *     em `llm_calls` sob a trava de `contacts` é o ciclo da #2363).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const corpoDoSendMessage = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

describe("resposta em nota de voz no send_message", () => {
  it("prepara chave e teto ANTES da cadeia", () => {
    const preparo = corpoDoSendMessage.indexOf("await prepararVoz()");
    const cadeia = corpoDoSendMessage.indexOf("runBeforeSend(beforeSendArgs)");
    expect(preparo).toBeGreaterThan(-1);
    expect(preparo).toBeLessThan(cadeia);
  });

  it("sintetiza dentro do `send` do guardrail, com o corpo aprovado", () => {
    const send = corpoDoSendMessage.slice(corpoDoSendMessage.indexOf("send: (finalBody: string) =>"));
    const geracao = send.indexOf("gerarNotaDeVoz({");
    expect(geracao).toBeGreaterThan(-1);
    expect(send.slice(geracao, geracao + 120)).toContain("texto: finalBody");
    // Toda falha da voz volta para o envio de texto, com o MESMO corpo aprovado.
    expect(send).toContain("return enviarComoTexto();");
  });

  it("grava custo e motivo depois da cadeia, e também no erro", () => {
    const depois = corpoDoSendMessage.indexOf("const outcome = chain.outcome;");
    expect(corpoDoSendMessage.indexOf("await gravarVozDoEnvio(", depois)).toBeGreaterThan(depois);
    const noCatch = corpoDoSendMessage.lastIndexOf("} catch (err) {");
    expect(corpoDoSendMessage.indexOf("await gravarVozDoEnvio(null)", noCatch)).toBeGreaterThan(noCatch);
  });
});
