import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A reentrega da Meta acorda o agente que a primeira entrega não acordou.
 *
 * O cenário: a primeira entrega grava a mensagem e o processo morre (timeout,
 * OOM, deploy) ANTES de `aplicarEfeitosPosEntrada` — que é quem abre o negócio
 * e emite `ai_agent.dispatch_requested`. A Meta, sem 2xx, reentrega. O INSERT
 * da reentrega dá `23505`, a ingestão devolvia `duplicate` e saía — e os
 * efeitos nunca rodavam: o agente não acordava para aquela mensagem, sem erro
 * e sem log.
 *
 * Agora a reentrega confere se o despacho daquela mensagem existe no
 * `event_log`. Não existe e a mensagem já tem idade → roda os efeitos (uma vez).
 * Existe → nada em dobro. Não existe mas a mensagem é de AGORA → a primeira
 * entrega pode estar no meio dos efeitos; a ingestão não corre com ela e pede
 * para o replay conferir depois.
 */

const ORG = "org-1";
const MSG = "msg-ja-gravada";

const estado = vi.hoisted(() => ({
  /** Despachos já registrados em `event_log`, por id de mensagem. */
  despachados: new Set<string>(),
  efeitos: [] as Array<Record<string, unknown>>,
  carimbos: [] as Array<Record<string, unknown>>,
  /** `created_at` da mensagem que a reentrega encontra. */
  criadaEm: "",
  /** `last_inbound_at` da conversa (o carimbo da 1ª entrega aconteceu?). */
  ultimaEntrada: null as string | null,
  filtrosDaMensagem: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/leads/atribuicao-de-anuncio", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  estamparAtribuicaoDoContato: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: async (_a: unknown, args: Record<string, unknown>) => {
    estado.carimbos.push(args);
  },
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  // O efeito que importa aqui é o despacho: ele passa a existir no event_log.
  aplicarEfeitosPosEntrada: async (_a: unknown, entrada: Record<string, unknown>) => {
    estado.efeitos.push(entrada);
    if (entrada.messageId) estado.despachados.add(entrada.messageId as string);
  },
}));

function cadeia(resolve: (filtros: Array<[string, unknown]>) => unknown) {
  const filtros: Array<[string, unknown]> = [];
  const q: Record<string, unknown> = {};
  for (const f of ["eq", "neq", "is", "in", "lt", "gt"]) {
    q[f] = (c: string, v: unknown) => (filtros.push([`${f}:${c}`, v]), q);
  }
  q.select = () => q;
  q.limit = () => q;
  q.order = () => q;
  q.maybeSingle = async () => resolve(filtros);
  return { q, filtros };
}

function adminFalso(): SupabaseClient {
  const from = (tabela: string) => {
    if (tabela === "channel_sessions") {
      return cadeia(() => ({ data: { id: "sess-1", organization_id: ORG }, error: null })).q;
    }
    if (tabela === "messages") {
      return {
        // Toda reentrega bate no unique (organization_id, external_id).
        insert: () => ({
          select: () => ({
            maybeSingle: async () => ({
              data: null,
              error: { code: "23505", message: "duplicate key" },
            }),
          }),
        }),
        select: () => {
          const { q, filtros } = cadeia(() => ({
            data: {
              id: MSG,
              contact_id: "contact-1",
              conversation_id: "conv-1",
              channel_session_id: "sess-1",
              body: "oi, quero saber o preço",
              sent_at: estado.criadaEm,
              created_at: estado.criadaEm,
            },
            error: null,
          }));
          estado.filtrosDaMensagem = filtros;
          return (q.select as () => unknown)();
        },
      };
    }
    if (tabela === "event_log") {
      return {
        select: () => {
          const { q } = cadeia((filtros) => {
            const id = filtros.find(([c]) => c === "eq:entity_id")?.[1] as string;
            const tipo = filtros.find(([c]) => c === "eq:event_type")?.[1];
            const ok = tipo === "ai_agent.dispatch_requested" && estado.despachados.has(id);
            return { data: ok ? { id: "ev-1" } : null, error: null };
          });
          return (q.select as () => unknown)();
        },
      };
    }
    if (tabela === "conversations") {
      return {
        select: () => {
          const { q } = cadeia(() => ({
            data: { last_inbound_at: estado.ultimaEntrada },
            error: null,
          }));
          return (q.select as () => unknown)();
        },
      };
    }
    throw new Error(`tabela inesperada: ${tabela}`);
  };
  const rpc = async (nome: string) => {
    if (nome === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (nome === "fn_upsert_wa_conversation") return { data: "conv-1", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";

const EVENTO: InboundMessageEvent = {
  kind: "inbound_message",
  wabaId: "waba-1",
  phoneNumberId: "pn-1",
  externalId: "wamid.REENTREGUE",
  from: "5531988887777",
  profileName: "Cliente",
  sentAt: new Date("2026-10-14T12:00:00.000Z"),
  type: "text",
  text: "oi, quero saber o preço",
  media: null,
};

const reentrega = () => ingestMetaInbound(adminFalso(), EVENTO, { organizationId: ORG });
const haDezMinutos = () => new Date(Date.now() - 10 * 60_000).toISOString();

beforeEach(() => {
  estado.despachados.clear();
  estado.efeitos.length = 0;
  estado.carimbos.length = 0;
  estado.criadaEm = haDezMinutos();
  estado.ultimaEntrada = null;
  estado.filtrosDaMensagem = [];
});

describe("reentrega `duplicate` de mensagem cujo despacho não aconteceu", () => {
  it("roda os efeitos pós-entrada para a mensagem JÁ gravada — uma vez só", async () => {
    const primeira = await reentrega();
    expect(primeira).toMatchObject({ status: "duplicate", efeitos: "retomados" });
    expect(estado.efeitos).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        messageId: MSG,
        contactId: "contact-1",
        conversationId: "conv-1",
        channelSessionId: "sess-1",
        texto: "oi, quero saber o preço",
      }),
    ]);

    // A Meta reentrega de novo: agora o despacho existe, e nada roda em dobro.
    const segunda = await reentrega();
    expect(segunda).toMatchObject({ status: "duplicate", efeitos: "ja_aplicados" });
    expect(estado.efeitos).toHaveLength(1);
  });

  it("a mensagem é procurada na organização do dono, pelo wamid", async () => {
    await reentrega();
    expect(estado.filtrosDaMensagem).toEqual(
      expect.arrayContaining([
        ["eq:organization_id", ORG],
        ["eq:external_id", EVENTO.externalId],
        ["eq:direction", "inbound"],
      ]),
    );
  });

  it("o carimbo da conversa que a 1ª entrega não deu é dado agora", async () => {
    estado.ultimaEntrada = null;
    await reentrega();
    expect(estado.carimbos).toHaveLength(1);
  });

  it("carimbo que já aconteceu não é repetido (o contador de não lidas não sobe duas vezes)", async () => {
    estado.ultimaEntrada = estado.criadaEm;
    await reentrega();
    expect(estado.carimbos).toEqual([]);
  });

  it("mensagem gravada AGORA → não corre com a 1ª entrega; pede para o replay conferir", async () => {
    estado.criadaEm = new Date().toISOString();
    const r = await reentrega();
    expect(r).toMatchObject({ status: "duplicate", efeitos: "em_andamento" });
    expect(estado.efeitos).toEqual([]);
  });
});

describe("reentrega `duplicate` de mensagem já despachada", () => {
  it("nada em dobro: nem efeitos, nem carimbo", async () => {
    estado.despachados.add(MSG);
    const r = await reentrega();
    expect(r).toMatchObject({ status: "duplicate", efeitos: "ja_aplicados" });
    expect(estado.efeitos).toEqual([]);
    expect(estado.carimbos).toEqual([]);
  });
});
