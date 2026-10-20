/**
 * Onde a nota de voz gerada mora: o bucket PRIVADO `whatsapp-media`, na pasta
 * da conversa (`<org>/<conversa>/voz-<uuid>.ogg`) — o mesmo lugar e o mesmo
 * caminho de toda mídia enviada. Por isso ela herda, sem código novo:
 *
 *  - a URL assinada curta que o handler de mensagens gera para a Meta baixar
 *    (`app/api/v1/messages/_handler.ts`, nunca base64);
 *  - a RETENÇÃO de mídia (`fn_enfileirar_midia_vencida`, por
 *    `messages.media_storage_path`) e a varredura de órfãos — um áudio gerado
 *    que não chegou a virar mensagem (falha no envio) é órfão e sai;
 *  - a EXCLUSÃO/ANONIMIZAÇÃO do contato (`lib/lgpd/redact-cascade.ts`), que
 *    apaga a mídia das mensagens dele.
 */
import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET_DA_CONVERSA = "whatsapp-media";

export function guardarNotaDeVozNaConversa(organizationId: string, conversationId: string) {
  return async (
    audio: Uint8Array,
    mime: "audio/ogg",
  ): Promise<{ ok: true; storagePath: string } | { ok: false; detalhe: string }> => {
    const storagePath = `${organizationId}/${conversationId}/voz-${randomUUID()}.ogg`;
    try {
      const { error } = await createAdminClient()
        .storage.from(BUCKET_DA_CONVERSA)
        .upload(storagePath, audio, { contentType: mime, upsert: false });
      if (error) return { ok: false, detalhe: error.message.slice(0, 200) };
      return { ok: true, storagePath };
    } catch (err) {
      return {
        ok: false,
        detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      };
    }
  };
}
