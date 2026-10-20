/**
 * A MENSAGEM QUE CHEGOU SEM DE QUEM — log e aviso, nunca silêncio.
 *
 * Com os usernames do WhatsApp a Meta pode omitir o telefone de quem escreve; a
 * identidade passa a ser o BSUID (`./bsuid.ts`). Uma mensagem sem NENHUM dos
 * dois não tem como virar contato nem ser respondida — e até aqui ela sumia
 * dentro do parser (`if (!id || !from) continue`), com 200 para a Meta e nada
 * em lugar nenhum.
 *
 * ─── Por que `event_dead`, e não um kind novo ───────────────────────────────
 *
 * `agent_inbox_items.kind` tem CHECK; um kind novo pediria migration, rótulo
 * pt/es e política de destino para dizer o que `event_dead` já diz: "um evento
 * recebido não pôde ser processado" (`lib/ai/agent-inbox-copy.ts`). O que
 * separa este aviso dos outros `event_dead` é o TÍTULO fixo — e o índice único
 * parcial da 0491 (`organization_id, kind, title` com `status = 'open'`) é o
 * que impede a Central de encher: um aviso aberto por organização, até alguém
 * marcá-lo resolvido. É o mesmo desenho do `MENSAGEM_QUE_NAO_ENTROU` do replay.
 *
 * ─── Por que NÃO pede reprocessamento ───────────────────────────────────────
 *
 * Reprocessar o mesmo corpo dá o mesmo vazio: a identidade não está lá. O
 * desfecho vai para o corpo da resposta (`sem_identidade`) e para o log; o
 * arquivo do webhook fica `processed`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { DETALHE_TECNICO } from "@/lib/event-log/aviso-de-evento-morto";
import { logger } from "@/lib/logger";

import type { InboundSemIdentidadeEvent } from "./webhook";

export const MENSAGEM_SEM_REMETENTE = {
  titulo: "Uma mensagem do WhatsApp oficial chegou sem remetente",
  corpo:
    "A Meta entregou uma mensagem sem o telefone e sem o identificador de quem a enviou, " +
    "então ela não virou conversa e a IA não a respondeu. Confira no celular do número as " +
    "conversas recebidas nesse horário e responda por lá. Enquanto este aviso estiver aberto, " +
    "outras mensagens assim não abrem aviso novo: depois de conferir, marque-o como resolvido.",
} as const;

/**
 * Escreve o log estruturado e abre (ou mantém) o aviso na Central.
 *
 * NUNCA lança: o webhook segue para os outros eventos do corpo, e a Meta
 * recebe 200 de qualquer jeito — uma exceção aqui viraria reentrega em laço de
 * um corpo que nunca vai melhorar.
 */
export async function avisarMensagemSemIdentidade(
  admin: SupabaseClient,
  organizationId: string,
  e: InboundSemIdentidadeEvent,
  requestId: string,
): Promise<void> {
  // Nada pessoal no log: não HÁ telefone nem BSUID, e o corpo da mensagem não
  // é assunto de log. O `wamid` e o número nosso bastam para achar o caso.
  logger.warn("[meta.ingest] mensagem recebida sem telefone e sem BSUID", {
    request_id: requestId,
    organization_id: organizationId,
    external_id: e.externalId,
    phone_number_id: e.phoneNumberId,
    type: e.type,
  });
  try {
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "event_dead",
      severity: "warn",
      title: MENSAGEM_SEM_REMETENTE.titulo,
      body:
        `${MENSAGEM_SEM_REMETENTE.corpo}\n\n${DETALHE_TECNICO} ` +
        `phone_number_id=${e.phoneNumberId || "?"}, wamid=${e.externalId}, tipo=${e.type}.`,
    });
    // `23505` = já há um aviso aberto com este título (índice da 0491): é o
    // desfecho que se queria — a Central já diz o que precisa ser dito.
    if (error && error.code !== "23505") {
      logger.error("[meta.ingest] aviso de mensagem sem remetente falhou", {
        request_id: requestId,
        organization_id: organizationId,
        detail: error.message,
      });
    }
  } catch (err) {
    logger.error("[meta.ingest] aviso de mensagem sem remetente falhou", {
      request_id: requestId,
      organization_id: organizationId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
