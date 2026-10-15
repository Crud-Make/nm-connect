/**
 * O PROCESSAMENTO DE UM WEBHOOK DA META — o mesmo para a rota e para o replay.
 *
 * Morava dentro de `app/api/v1/webhooks/meta/[token]/route.ts`. Saiu porque o
 * cron `webhook-replay` precisa reprocessar o corpo arquivado pela MESMA regra:
 * duas cópias divergem na primeira correção que só uma delas recebe.
 *
 * ─── Por que reprocessar o corpo inteiro é seguro ───────────────────────────
 *
 * Um corpo da Meta pode trazer vários eventos, e o replay passa todos de novo.
 * Cada ramo já tolera reentrega, porque a própria Meta reentrega o que não
 * recebe 2xx:
 *
 *   - mensagem recebida e eco do app: `unique (organization_id, external_id)`
 *     vira `23505` → `duplicate` (e a recebida confere se o agente foi acordado);
 *   - contato do app: upsert;
 *   - status de template: update para o mesmo valor;
 *   - status de mensagem: `.neq("status", "failed")` e carimbos que só andam
 *     para trás no tempo (`soSeMaisAntigo`); a falha só emite uma vez.
 *
 * ─── A organização é SEMPRE a da sessão ─────────────────────────────────────
 *
 * `session` chega resolvida pelo TOKEN do path (rota) ou pela linha do arquivo
 * que a rota gravou com ele (replay). Nenhum ramo lê organização do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import {
  emitirFalhaDeEntrega,
  telefoneDoEmbed,
  type EmbedDoContato,
} from "@/lib/messaging/falha-de-entrega";
import { PREFIXO_TRANSITORIA } from "@/lib/waha/falha-transitoria";

import type { MetaWebhookEnvelope } from "./envelope";
import { ingestMetaAppContactSync, ingestMetaEcho, ingestMetaInbound } from "./ingest";
import type { MetaWebhookSession } from "./session";
import { carimbosDeEntrega, soSeMaisAntigo, statusUpdate } from "./status-update";
import { parseMetaWebhook } from "./webhook";

type Admin = SupabaseClient;

export interface ResultadoDoWebhookMeta {
  /** Quantos eventos o corpo trouxe (o `received` da resposta). */
  recebidos: number;
  /** Desfecho de cada ingestão, na ordem — o `outcomes` da resposta. */
  desfechos: string[];
  /**
   * Motivo para o arquivo ser reprocessado, ou `null`. Preenchido quando uma
   * ingestão devolveu `failed`, ou quando a reentrega não pôde conferir os
   * efeitos de uma mensagem que já existia.
   */
  pendencia: string | null;
  /**
   * Falha que reprocessar não conserta (`no_session`: o número não é desta
   * organização). Deixa o arquivo `error`, contável, mas fora do replay.
   */
  recusa: string | null;
}

/** O que fica gravado no arquivo para cada resultado. */
export function desfechoDoArquivoMeta(r: ResultadoDoWebhookMeta): {
  status: "processed" | "error";
  erro: string | null;
} {
  // O prefixo é o marcador que o cron `webhook-replay` relê — o mesmo do canal
  // por QR (`lib/waha/desfecho-do-webhook.ts`). Pendência vence recusa: uma
  // mensagem que ainda pode entrar não é escondida por outra que não entra.
  if (r.pendencia)
    return { status: "error", erro: `${PREFIXO_TRANSITORIA} ${r.pendencia}`.slice(0, 500) };
  if (r.recusa) return { status: "error", erro: r.recusa.slice(0, 500) };
  return { status: "processed", erro: null };
}

/** Exceção no meio do processamento: o arquivo fica marcado para o replay. */
export function desfechoDaExcecaoMeta(err: unknown): { status: "error"; erro: string } {
  const detalhe = err instanceof Error ? err.message : String(err);
  return { status: "error", erro: `${PREFIXO_TRANSITORIA} excecao: ${detalhe}`.slice(0, 500) };
}

export async function processarWebhookMeta(
  admin: Admin,
  session: MetaWebhookSession,
  envelope: MetaWebhookEnvelope,
  requestId: string,
): Promise<ResultadoDoWebhookMeta> {
  const eventos = parseMetaWebhook(envelope);
  const now = new Date().toISOString();
  /**
   * Desfecho de cada ingestão. Existe porque a versão anterior fazia
   * `await ingestMetaInbound(...)` e DESCARTAVA o retorno: um insert que falhava
   * virava `{"received": 1}` com nada gravado, e "chegou e falhou" ficava
   * indistinguível de "não chegou". Custou uma hora de diagnóstico no lugar errado.
   */
  const desfechos: string[] = [];
  const pendencias: string[] = [];
  const recusas: string[] = [];

  for (const e of eventos) {
    // O evento chega carimbado com a WABA; se não for a desta sessão, ignoramos.
    // Confiar no `entry.id` para escolher a org seria aceitar o corpo como fonte.
    if (session.wabaId && e.wabaId && e.wabaId !== session.wabaId) continue;

    if (e.kind === "inbound_message") {
      // A metade que faltava: mensagem do contato vira linha no inbox, move lead,
      // acorda o agente — e carimba `last_inbound_at`, que é o que ABRE a janela
      // de 24h que o gate da Fase 4 calcula.
      // A organização vem do TOKEN DO PATH, nunca do corpo: é a mesma fonte que
      // decide onde os updates abaixo escrevem. Sem ela a ingestão resolvia a
      // sessão só pelo `phone_number_id` do payload — e duas organizações com o
      // mesmo número faziam a mensagem ser descartada para as duas, com 200 na
      // resposta (issue #236).
      const r = await ingestMetaInbound(admin, e, { organizationId: session.organizationId });
      desfechos.push(r.status === "duplicate" && r.efeitos ? `duplicate:${r.efeitos}` : r.status);
      if (r.status === "failed" || r.status === "no_session") {
        // 2xx continua (a Meta re-entregaria em loop), mas a falha NÃO fica muda:
        // vai ao log estruturado, ao corpo da resposta e ao arquivo — e `failed`
        // fica marcado para o replay reprocessar. Era `console.error`, e a
        // mensagem do cliente se perdia aqui.
        logger.error("[meta.ingest] inbound não ingerido", {
          request_id: requestId,
          organization_id: session.organizationId,
          status: r.status,
          reason: r.status === "failed" ? r.reason : undefined,
          external_id: e.externalId,
          phone_number_id: e.phoneNumberId,
        });
        if (r.status === "failed") pendencias.push(`inbound ${e.externalId}: ${r.reason}`);
        else recusas.push(`no_session: ${e.phoneNumberId}`);
      } else if (
        r.status === "duplicate" &&
        (r.efeitos === "em_andamento" || r.efeitos === "nao_conferidos")
      ) {
        pendencias.push(`inbound ${e.externalId}: efeitos ${r.efeitos}`);
      }
      continue;
    }

    if (e.kind === "outbound_echo") {
      // Coexistência: resposta dada pelo app WhatsApp Business. Entra na conversa
      // como saída de humano e pausa a IA — ver `ingestMetaEcho`. Mesma política
      // de falha da recebida: 2xx sempre, falha no log, no corpo e no arquivo.
      const r = await ingestMetaEcho(admin, e, { organizationId: session.organizationId });
      desfechos.push(`eco:${r.status}`);
      if (r.status === "failed" || r.status === "no_session") {
        logger.error("[meta.ingest] eco do app não ingerido", {
          request_id: requestId,
          status: r.status,
          reason: r.status === "failed" ? r.reason : undefined,
          external_id: e.externalId,
          phone_number_id: e.phoneNumberId,
        });
        if (r.status === "failed") pendencias.push(`eco ${e.externalId}: ${r.reason}`);
        else recusas.push(`no_session: ${e.phoneNumberId}`);
      }
      continue;
    }

    if (e.kind === "app_contact_sync") {
      // Coexistência: contato criado/editado no ENDEREÇO do app. Entra no CRM com
      // o nome do celular — sem conversa, sem mensagem e sem tocar na IA, porque
      // nada foi trocado (ver `ingestMetaAppContactSync`). Mesma política de
      // falha das outras duas.
      const r = await ingestMetaAppContactSync(admin, e, {
        organizationId: session.organizationId,
      });
      desfechos.push(`contato:${r.status}`);
      if (r.status === "failed" || r.status === "no_session") {
        logger.error("[meta.ingest] contato do app não sincronizado", {
          request_id: requestId,
          status: r.status,
          reason: r.status === "failed" ? r.reason : undefined,
          phone_number_id: e.phoneNumberId,
        });
        if (r.status === "failed") pendencias.push(`contato: ${r.reason}`);
        else recusas.push(`no_session: ${e.phoneNumberId}`);
      }
      continue;
    }

    if (e.kind === "template_status") {
      await admin
        .from("meta_templates")
        .update({ status: e.event, rejected_reason: e.reason, updated_at: now })
        .eq("organization_id", session.organizationId)
        .eq("waba_id", e.wabaId)
        .eq("name", e.templateName)
        .eq("language", e.templateLanguage);
    } else if (e.status === "failed") {
      // A recusa da plataforma chega DEPOIS do 200 (131047 fora da janela,
      // 131026 número não registrado, 132015 template pausado). O evento inteiro
      // vira colunas como no ramo de baixo — e a falha emite `message.failed`
      // para quem integra (#1614), que até aqui não tinha gatilho nenhum.
      //
      // `.neq("status", "failed")` é o "uma vez": a Meta reentrega o mesmo
      // status enquanto não recebe 2xx, e cada reentegra seria mais um aviso
      // para o sistema do integrador sobre a MESMA falha. Só a primeira
      // atualiza uma linha, e só a primeira devolve linha — `linha` é o gatilho
      // da emissão, então 0 linhas = 0 eventos.
      const { data: linha } = await admin
        .from("messages")
        .update(statusUpdate(e, now))
        .eq("organization_id", session.organizationId)
        .eq("external_id", e.externalId)
        .neq("status", "failed")
        .select(
          "id, conversation_id, contact_id, sent_via, error_code, error_message, contacts:contact_id(phone_number)",
        )
        .maybeSingle();
      if (linha) {
        const falha = linha as {
          id: string;
          conversation_id: string | null;
          contact_id: string | null;
          sent_via: string | null;
          error_code: string | null;
          error_message: string | null;
          // FK de N para 1: o PostgREST devolve OBJETO em tempo de execução,
          // embora a tipagem gerada diga lista. `telefoneDoEmbed` aceita os dois.
          contacts: EmbedDoContato;
        };
        await emitirFalhaDeEntrega(admin, {
          organizationId: session.organizationId,
          source: "meta-status-webhook",
          requestId,
          falha: {
            message_id: falha.id,
            conversation_id: falha.conversation_id,
            contact_id: falha.contact_id,
            contact: telefoneDoEmbed(falha.contacts),
            sent_via: falha.sent_via,
            erro: { codigo: falha.error_code ?? "", titulo: falha.error_message },
          },
        });
      }
    } else {
      // O evento inteiro vira colunas, não só `status`: quando a Meta ACEITA o
      // template e reprova a entrega depois, o motivo só existe aqui. Ver
      // `lib/channels/meta/status-update.ts`.
      //
      // `.neq("status", "failed")` em TODO update deste ramo: a Meta entrega
      // fora de ordem e reentrega, e um `delivered` que chega depois do
      // `failed` reabria a mensagem como enviada. Falha é terminal aqui — e o
      // "uma vez" da emissão acima continua valendo, porque este ramo nunca
      // tira a linha de `failed`.
      await admin
        .from("messages")
        .update(statusUpdate(e, now))
        .eq("organization_id", session.organizationId)
        .eq("external_id", e.externalId)
        .neq("status", "failed");
      // Um update por carimbo, porque cada um tem a sua condição: só grava se a
      // coluna está nula ou guarda instante POSTERIOR ao do evento. Reentrega
      // não move o carimbo; `delivered` atrasado depois de `read` o corrige
      // para trás.
      for (const c of carimbosDeEntrega(e, now)) {
        await admin
          .from("messages")
          .update({ [c.coluna]: c.em })
          .eq("organization_id", session.organizationId)
          .eq("external_id", e.externalId)
          .neq("status", "failed")
          .or(soSeMaisAntigo(c));
      }
    }
  }

  return {
    recebidos: eventos.length,
    desfechos,
    pendencia: pendencias.length > 0 ? pendencias.join("; ") : null,
    recusa: recusas.length > 0 ? recusas.join("; ") : null,
  };
}
