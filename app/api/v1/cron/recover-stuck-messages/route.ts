/**
 * GET/POST /api/v1/cron/recover-stuck-messages — issue #129.
 *
 * Mensagem outbound nasce com `status='sending'` e só sai desse estado quando
 * quem envia confirma (ack do canal, resposta do worker). Quando o envio nunca
 * acontece, a linha fica `sending` PARA SEMPRE — e o que o self-hoster vê no
 * inbox é uma mensagem eternamente "enviando": um sinal de progresso para algo
 * que não vai acontecer.
 *
 * Essa é a pior forma de falha num produto que a pessoa instala sozinha numa
 * VPS: não há ninguém monitorando, então ela conclui que o produto é lento, não
 * que está quebrado, e nunca abre um chamado. O `CLAUDE.md` e o PRD 03 prometem
 * este cron desde o começo (regra de negócio W-12); ele simplesmente não
 * existia — o `git grep` só achava a promessa, nunca a rota.
 *
 * O que ele faz, e o que deliberadamente NÃO faz:
 *
 *   - marca `failed` toda outbound `sending` mais velha que 5 min (o prazo do
 *     `CLAUDE.md`), gravando `error_code`/`error_message` para quem investigar;
 *   - emite `message.failed` por mensagem, como manda a regra W-12. Não dá para
 *     contar com o trigger: `trg_messages_emit_event` é AFTER **INSERT**, então
 *     mudança de status não emite nada — o evento que a regra promete só existe
 *     se este cron o emitir;
 *   - abre UM aviso por organização por rodada na Central de avisos
 *     (`agent_inbox_items`, kind `message_send_stuck`), porque marcar `failed`
 *     em silêncio troca uma falha invisível por outra: a bolha muda de ícone
 *     numa conversa que ninguém tem motivo para reabrir;
 *   - **não reenvia nada.** Reenviar exigiria saber POR QUE não foi, e o envio
 *     em dobro é pior que o não-envio: o cliente recebe a mesma mensagem duas
 *     vezes. Retry é decisão de quem lê o aviso.
 *
 * E uma segunda varredura, para `queued` (`recoverStuckQueued`, C3):
 *
 *   - `queued` só tem resgate automático no canal que o watchdog do
 *     agent-engine alcança (`PROVIDERS_COM_RESGATE_DA_FILA`). Nos outros — o
 *     canal oficial e os que espelham a Cloud API — a resposta da IA que caiu em
 *     `queued` (credencial ausente, sessão fora, processo morto no meio do
 *     envio) não saía nunca e não virava falha: o `inbound_turn` encerra o job
 *     dizendo ao modelo que "o canal envia quando voltar", e ninguém envia;
 *   - por isso, nesses canais, a mensagem AUTOMÁTICA (`ai`/`automation`/
 *     `system`) em `queued` há mais que o mesmo prazo, sem `external_id`, sem
 *     recibo `accepted` no `send_ledger` e SEM JOB DONO VIVO, vira `failed`
 *     com `queued_timeout` — com o mesmo evento e o mesmo aviso de `sending`;
 *   - job dono vivo (`pending`/`running`, achado pelo `send_ledger`) é o
 *     follow-up que ainda vai reprocessar a linha com a mesma chave: falhá-la
 *     brigaria com ele. É o "esse estado tem dono" do `CLAUDE.md`, agora
 *     verificado em vez de presumido;
 *   - também não reenvia: sem `external_id` não há como saber se a plataforma
 *     já aceitou a linha de um processo que morreu no meio.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O agendamento
 * vive no serviço `scheduler` do `docker-compose.prod.yml`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  emitirFalhaDeEntrega,
  telefoneDoEmbed,
  type EmbedDoContato,
} from "@/lib/messaging/falha-de-entrega";
import { providersSemResgateDaFila } from "@/lib/channels/capabilities";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/**
 * Prazo do `CLAUDE.md` (seção de canal) e da regra W-12. Não é chute: é maior que
 * qualquer envio legítimo (o throttle anti-ban trabalha em segundos) e menor
 * que a paciência de quem está olhando a tela.
 */
export const STUCK_AFTER_MS = 5 * 60 * 1000;

/** Teto por invocação — a rodada seguinte pega o resto. */
const SCAN_LIMIT = 500;

interface StuckMessage {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string | null;
  created_at: string;
  sent_via: string;
  contacts: EmbedDoContato;
}

export interface RecoverResult {
  scanned: number;
  failed: number;
  organizations: number;
}

/** O texto do aviso na Central — cada varredura diz o que aconteceu com a dela. */
interface Aviso {
  title: (n: number) => string;
  body: string;
}

/**
 * Marca `failed`, emite `message.failed` e abre UM aviso por organização — a
 * mecânica que as duas varreduras (`sending` e `queued`) compartilham.
 *
 * `statusEsperado` é o claim atômico: o UPDATE só pega a linha que AINDA está
 * no estado em que a varredura a encontrou. Se o envio concluiu entre o SELECT
 * e o UPDATE (ack, ou o dono da fila reenviando), a linha não é tocada.
 */
async function falharEAvisar<T extends StuckMessage>(
  admin: ReturnType<typeof createAdminClient>,
  presas: T[],
  opts: {
    now: Date;
    requestId: string;
    statusEsperado: "sending" | "queued";
    codigo: string;
    motivo: (m: T) => string;
    aviso: Aviso;
  },
): Promise<{ failed: number; organizations: number }> {
  const porOrg = new Map<string, T[]>();
  for (const m of presas)
    porOrg.set(m.organization_id, [...(porOrg.get(m.organization_id) ?? []), m]);

  let marcadas = 0;
  let orgsComAviso = 0;

  for (const [orgId, mensagens] of porOrg) {
    // Um motivo por mensagem só quando ele varia (o da fila carrega o
    // `queued_reason`); o de `sending` é um texto só, e um UPDATE só.
    const porMotivo = new Map<string, T[]>();
    for (const m of mensagens) {
      const motivo = opts.motivo(m);
      porMotivo.set(motivo, [...(porMotivo.get(motivo) ?? []), m]);
    }

    const marcadasAgora: { id: string }[] = [];
    const motivoDe = new Map<string, string>();
    for (const [motivo, grupo] of porMotivo) {
      // O `.eq("status", ...)` no UPDATE É o claim atômico: se o envio
      // concluiu entre o SELECT e o UPDATE (corrida real — o ack pode chegar a
      // qualquer momento), a linha já não está no estado e não é tocada. Sem
      // isso, este cron marcaria como falha uma mensagem que o cliente recebeu.
      const { data: updated, error: updErr } = await admin
        .from("messages")
        .update({
          status: "failed",
          error_code: opts.codigo,
          error_message: motivo,
          updated_at: opts.now.toISOString(),
        })
        .in(
          "id",
          grupo.map((m) => m.id),
        )
        .eq("organization_id", orgId)
        .eq("status", opts.statusEsperado)
        .select("id");

      if (updErr) {
        logger.error("[recover-stuck-messages] update falhou", {
          error: updErr.message,
          organization_id: orgId,
          status: opts.statusEsperado,
          requestId: opts.requestId,
        });
        continue;
      }
      for (const row of (updated ?? []) as { id: string }[]) {
        marcadasAgora.push(row);
        motivoDe.set(row.id, motivo);
      }
    }
    const n = marcadasAgora.length;
    if (n === 0) continue; // outra rodada (ou o ack) chegou primeiro
    marcadas += n;
    orgsComAviso += 1;

    // W-12 promete o evento `message.failed`. O trigger não serve: ele é AFTER
    // INSERT, então mudar o status não emite nada. Só as linhas que ESTE tick
    // realmente marcou — emitir pelas que a corrida levou seria evento de uma
    // falha que não houve.
    // O MESMO contrato do envio e do webhook da Meta (`emitirFalhaDeEntrega`,
    // #1614): quem integra assina um `message.failed` só, e a condição
    // `event.erro.codigo = send_timeout` casa aqui como casa lá.
    const porMensagem = new Map(mensagens.map((m) => [m.id, m]));
    await Promise.all(
      marcadasAgora.map(({ id }) => {
        const m = porMensagem.get(id);
        return emitirFalhaDeEntrega(admin, {
          organizationId: orgId,
          source: "recover-stuck-messages",
          requestId: opts.requestId,
          falha: {
            message_id: id,
            conversation_id: m?.conversation_id ?? null,
            contact_id: m?.contact_id ?? null,
            contact: telefoneDoEmbed(m?.contacts),
            sent_via: m?.sent_via ?? null,
            erro: { codigo: opts.codigo, titulo: motivoDe.get(id) ?? opts.codigo },
          },
        });
      }),
    );

    // Um aviso por org por rodada, não um por mensagem: quando um worker cai, o
    // que trava não é uma mensagem, é o envio inteiro — N avisos idênticos
    // enterrariam a Central de avisos exatamente no dia em que ela mais precisa
    // ser lida.
    const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
      organization_id: orgId,
      kind: "message_send_stuck",
      severity: "critical",
      title: opts.aviso.title(n),
      body: opts.aviso.body,
      ref_kind: "conversation",
      ref_id: mensagens[0]?.conversation_id ?? null,
    });
    if (inboxErr) {
      // O aviso é o que torna a falha visível; perdê-lo em silêncio recriaria o
      // defeito que este cron existe para consertar.
      logger.error("[recover-stuck-messages] aviso na Central falhou", {
        error: inboxErr.message,
        organization_id: orgId,
        requestId: opts.requestId,
      });
    }
  }

  return { failed: marcadas, organizations: orgsComAviso };
}

/**
 * Separado do handler HTTP para o teste poder exercitar a REGRA sem montar
 * request/auth — e para o handler ficar sendo só borda.
 */
export async function recoverStuckMessages(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  requestId: string,
): Promise<RecoverResult> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();

  // O corte é por `created_at`, como a regra W-12 escreve — e não por `sent_at`,
  // que é o campo que o caminho de envio reescreve. Medir a idade pela coluna
  // que outro código atualiza faria a mensagem rejuvenescer e escapar do cron.
  const { data, error } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, contact_id, created_at, sent_via, contacts:contact_id(phone_number)",
    )
    .eq("direction", "outbound")
    .eq("status", "sending")
    .lt("created_at", cutoff)
    .limit(SCAN_LIMIT);

  if (error) throw new Error(`query_failed: ${error.message}`);

  const stuck = (data ?? []) as StuckMessage[];
  if (stuck.length === 0) return { scanned: 0, failed: 0, organizations: 0 };

  const MOTIVO_DO_TIMEOUT = `Envio não confirmado em ${STUCK_AFTER_MS / 60000} min — marcada como falha por recover-stuck-messages.`;
  const r = await falharEAvisar(admin, stuck, {
    now,
    requestId,
    statusEsperado: "sending",
    codigo: "send_timeout",
    motivo: () => MOTIVO_DO_TIMEOUT,
    aviso: {
      title: (n) =>
        n === 1 ? "Uma resposta não chegou ao cliente" : `${n} respostas não chegaram ao cliente`,
      body:
        `Ficaram mais de ${STUCK_AFTER_MS / 60000} minutos aguardando envio e foram marcadas como falha. ` +
        `Verifique se a conexão do WhatsApp está ativa e se o worker de envio está rodando. ` +
        `Nada foi reenviado automaticamente — reenviar sem saber a causa arrisca mandar a mesma mensagem duas vezes.`,
    },
  });

  return { scanned: stuck.length, ...r };
}

/**
 * Quem pode estar em `queued` sem dono: só o envio AUTOMÁTICO. A mensagem do
 * atendente fica na tela dele, que a vê presa e decide; e é exatamente esta a
 * população que o watchdog resgata no canal que ele alcança.
 */
const ORIGENS_AUTOMATICAS = ["ai", "automation", "system"];

/** Job que ainda vai reprocessar a linha com a mesma chave do `send_ledger`. */
const JOB_VIVO = new Set(["pending", "running"]);

interface QueuedPresa extends StuckMessage {
  metadata: { queued_reason?: unknown; idempotency_key?: unknown } | null;
}

/**
 * A varredura de `queued` nos canais SEM resgate da fila — ver o cabeçalho.
 *
 * Separada de `recoverStuckMessages` para cada regra ter o seu teste e o seu
 * resultado: a de `sending` não tem dono a consultar; esta tem.
 */
export async function recoverStuckQueued(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  requestId: string,
): Promise<RecoverResult> {
  // O mesmo prazo de `sending`, e pelo mesmo motivo: é maior que qualquer envio
  // legítimo em voo (a linha nasce `queued` antes de falar com o canal e sai em
  // segundos). Esperar mais não traz a mensagem de volta — sem dono, ninguém a
  // reenvia — só adia o aviso. Quem ainda vai reenviar (job vivo) é excluído
  // abaixo, então o prazo não precisa cobrir o `SEND_QUEUED_RETRY_MS`.
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();

  const { data, error } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, contact_id, created_at, sent_via, metadata, contacts:contact_id(phone_number), channel_sessions!inner(provider)",
    )
    .eq("direction", "outbound")
    .eq("status", "queued")
    .in("sent_via", ORIGENS_AUTOMATICAS)
    // Com `external_id`, a plataforma JÁ aceitou: a linha só não aprendeu que
    // saiu. Falhá-la seria mentir sobre uma entrega; reenviá-la, mandar duas.
    .is("external_id", null)
    .in("channel_sessions.provider", providersSemResgateDaFila())
    .lt("created_at", cutoff)
    .limit(SCAN_LIMIT);

  if (error) throw new Error(`query_queued_failed: ${error.message}`);

  const candidatas = (data ?? []) as QueuedPresa[];
  if (candidatas.length === 0) return { scanned: 0, failed: 0, organizations: 0 };

  // ─── Quem ainda é dono da linha ──────────────────────────────────────────
  // A chave do `send_ledger` é o próprio `messages.id` (o envio grava
  // `internalMessageId = chave`); linha antiga a carrega em
  // `metadata.idempotency_key`. E depois que o handler responde, o ledger
  // aponta para a linha em `crm_message_id`.
  const ids = candidatas.map((m) => m.id);
  const chaves = [
    ...new Set([
      ...ids,
      ...candidatas
        .map((m) => m.metadata?.idempotency_key)
        .filter((k): k is string => typeof k === "string" && /^[0-9a-f-]{36}$/i.test(k)),
    ]),
  ];
  const { data: recibos, error: ledgerErr } = await admin
    .from("send_ledger")
    .select("id, crm_message_id, job_id, status")
    .or(`id.in.(${chaves.join(",")}),crm_message_id.in.(${ids.join(",")})`);
  // Sem conseguir saber quem é dono, não marca nada: falhar uma mensagem que um
  // follow-up ainda ia mandar é o erro que esta varredura promete não cometer.
  if (ledgerErr) throw new Error(`query_send_ledger_failed: ${ledgerErr.message}`);

  const recibosDe = new Map<string, { job_id: string | null; status: string }[]>();
  for (const r of (recibos ?? []) as {
    id: string;
    crm_message_id: string | null;
    job_id: string | null;
    status: string;
  }[]) {
    for (const m of candidatas) {
      const chave =
        typeof m.metadata?.idempotency_key === "string" ? m.metadata.idempotency_key : null;
      if (r.id === m.id || r.crm_message_id === m.id || (chave !== null && r.id === chave)) {
        recibosDe.set(m.id, [...(recibosDe.get(m.id) ?? []), r]);
      }
    }
  }

  const jobIds = [
    ...new Set(
      [...recibosDe.values()]
        .flat()
        .map((r) => r.job_id)
        .filter((j): j is string => j !== null),
    ),
  ];
  const jobsVivos = new Set<string>();
  if (jobIds.length > 0) {
    const { data: jobs, error: jobErr } = await admin
      .from("job_queue")
      .select("id, status")
      .in("id", jobIds);
    if (jobErr) throw new Error(`query_job_queue_failed: ${jobErr.message}`);
    for (const j of (jobs ?? []) as { id: string; status: string }[]) {
      if (JOB_VIVO.has(j.status)) jobsVivos.add(j.id);
    }
  }

  const orfas = candidatas.filter((m) => {
    const rs = recibosDe.get(m.id) ?? [];
    // Recibo `accepted`: o canal aceitou e a linha não aprendeu — não é falha.
    if (rs.some((r) => r.status === "accepted")) return false;
    return !rs.some((r) => r.job_id !== null && jobsVivos.has(r.job_id));
  });
  if (orfas.length === 0) return { scanned: candidatas.length, failed: 0, organizations: 0 };

  const minutos = STUCK_AFTER_MS / 60000;
  const r = await falharEAvisar(admin, orfas, {
    now,
    requestId,
    statusEsperado: "queued",
    codigo: "queued_timeout",
    motivo: (m) => {
      const razao = m.metadata?.queued_reason;
      return (
        `Ficou mais de ${minutos} min na fila de um canal que não reenvia sozinho` +
        (typeof razao === "string" ? ` (motivo da fila: ${razao})` : "") +
        ` — marcada como falha por recover-stuck-messages. Nada foi reenviado.`
      );
    },
    aviso: {
      title: (n) =>
        n === 1 ? "Uma resposta não saiu da fila" : `${n} respostas não saíram da fila`,
      body:
        `Ficaram mais de ${minutos} minutos na fila de envio de uma conexão que não reenvia sozinha ` +
        `(credencial ausente, conexão fora do ar ou envio interrompido) e foram marcadas como falha. ` +
        `Confira a conexão na Central de Conexões e reenvie pela conversa se ainda fizer sentido. ` +
        `Nada foi reenviado automaticamente — sem a confirmação do canal, reenviar arrisca mandar a mesma mensagem duas vezes.`,
    },
  });

  return { scanned: candidatas.length, ...r };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: RecoverResult & { queued: RecoverResult };
  try {
    const admin = createAdminClient();
    const agora = new Date();
    const sending = await recoverStuckMessages(admin, agora, requestId);
    const queued = await recoverStuckQueued(admin, agora, requestId);
    result = { ...sending, queued };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[recover-stuck-messages] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to recover stuck messages.", 500, { requestId });
  }

  // Varredura que não marcou nada não é mutação e não ocupa linha de auditoria
  // (mesmo critério do snooze-watcher e do followup-flow-worker).
  if (result.failed + result.queued.failed > 0) {
    void audit({
      action: "message.recover_stuck_run",
      organizationId: null,
      bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
