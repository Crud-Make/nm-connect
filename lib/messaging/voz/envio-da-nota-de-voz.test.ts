import { describe, expect, it } from "vitest";

import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";

const base = {
  tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
  leadId: "lead",
  jobId: "job",
  seq: 1,
  conversationId: "cccccccc-0000-4000-8000-000000000001",
};

describe("corpoDoEnvio — a nota de voz chega ao handler como ÁUDIO", () => {
  it("mime audio/* vira type audio (o adaptador da Meta manda voice:true), com o texto falado no body", () => {
    expect(
      corpoDoEnvio(
        {
          ...base,
          body: "Sua audiência é em 15/03/2026.",
          media: { storagePath: "org/conv/voz-1.ogg", mime: "audio/ogg" },
        },
        "k",
      ),
    ).toEqual({
      conversation_id: base.conversationId,
      type: "audio",
      media_storage_path: "org/conv/voz-1.ogg",
      media_mime: "audio/ogg",
      // O body é a transcrição da própria resposta: a equipe lê na Inbox o que
      // o cliente ouviu. A Meta não leva legenda em áudio.
      body: "Sua audiência é em 15/03/2026.",
      metadata: { idempotency_key: "k" },
    });
  });

  it("imagem continua imagem", () => {
    expect(
      corpoDoEnvio({ ...base, body: "", media: { storagePath: "p.jpg", mime: "image/jpeg" } }, "k"),
    ).toMatchObject({ type: "image" });
  });
});
