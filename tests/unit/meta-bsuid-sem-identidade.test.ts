import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MENSAGEM SEM IDENTIDADE NÃO SOME CALADA.
 *
 * Sem telefone e sem BSUID não há contato para criar — mas a mensagem existiu,
 * e alguém tem de saber. O que se prova aqui é o caminho de PRODUÇÃO
 * (`processarWebhookMeta`, o mesmo da rota e do replay): log estruturado,
 * aviso na Central, desfecho nomeado no corpo da resposta, e nenhuma
 * pendência de reprocessamento (o mesmo corpo daria o mesmo vazio).
 */
const estado = vi.hoisted(() => ({
  avisos: [] as Record<string, unknown>[],
  logs: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
  respostaDoInsert: { error: null as { code?: string; message: string } | null },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (msg: string, ctx: Record<string, unknown>) => estado.logs.push({ msg, ctx }),
    error: (msg: string, ctx: Record<string, unknown>) => estado.logs.push({ msg, ctx }),
    info: () => undefined,
    debug: () => undefined,
  },
}));
vi.mock("@/lib/channels/meta/ingest", () => ({
  ingestMetaInbound: async () => {
    throw new Error("mensagem sem identidade não pode chegar à ingestão");
  },
  ingestMetaEcho: async () => ({ status: "ingested" }),
  ingestMetaAppContactSync: async () => ({ status: "synced" }),
}));

import { processarWebhookMeta } from "@/lib/channels/meta/processar-webhook";

function adminFalso(): SupabaseClient {
  return {
    from: (tabela: string) => {
      if (tabela !== "agent_inbox_items") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        insert: async (linha: Record<string, unknown>) => {
          estado.avisos.push(linha);
          return estado.respostaDoInsert;
        },
      };
    },
  } as unknown as SupabaseClient;
}

const DOC = JSON.parse(readFileSync("tests/fixtures/meta/bsuid-da-doc.json", "utf8")) as Record<
  string,
  Record<string, unknown>
>;

function semIdentidade() {
  const env = JSON.parse(JSON.stringify(DOC.mensagem_so_bsuid)) as {
    entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[];
  };
  delete env.entry[0]!.changes[0]!.value.messages[0]!.from_user_id;
  return env;
}

const SESSAO = { organizationId: "org-1", wabaId: "102290129340398" } as never;

beforeEach(() => {
  estado.avisos = [];
  estado.logs = [];
  estado.respostaDoInsert = { error: null };
});

describe("mensagem recebida sem telefone e sem BSUID", () => {
  it("⭐ abre aviso na Central (event_dead, título fixo) com o detalhe técnico no fim", async () => {
    const r = await processarWebhookMeta(adminFalso(), SESSAO, semIdentidade() as never, "req-1");
    expect(estado.avisos).toHaveLength(1);
    expect(estado.avisos[0]).toMatchObject({
      organization_id: "org-1",
      kind: "event_dead",
      severity: "warn",
      title: "Uma mensagem do WhatsApp oficial chegou sem remetente",
    });
    expect(String(estado.avisos[0]!.body)).toContain("phone_number_id=106540352242922");
    expect(r.desfechos).toEqual(["sem_identidade"]);
    // Reprocessar o mesmo corpo daria o mesmo vazio: não fica pendente.
    expect(r.pendencia).toBeNull();
    expect(r.recusa).toBeNull();
  });

  it("escreve log estruturado — sem telefone, sem corpo da mensagem", async () => {
    await processarWebhookMeta(adminFalso(), SESSAO, semIdentidade() as never, "req-1");
    const log = estado.logs.find((l) => l.msg.includes("sem telefone e sem BSUID"));
    expect(log?.ctx).toMatchObject({
      request_id: "req-1",
      organization_id: "org-1",
      phone_number_id: "106540352242922",
      type: "text",
    });
    expect(JSON.stringify(log?.ctx)).not.toContain("Does it come in another color?");
  });

  it("aviso já aberto (23505 do índice da 0491) não é erro: a Central já está dizendo", async () => {
    estado.respostaDoInsert = { error: { code: "23505", message: "duplicate key" } };
    await processarWebhookMeta(adminFalso(), SESSAO, semIdentidade() as never, "req-1");
    expect(estado.logs.some((l) => l.msg.includes("falhou"))).toBe(false);
  });

  it("falha do banco no aviso vira log de erro e o webhook segue", async () => {
    estado.respostaDoInsert = { error: { code: "XX000", message: "banco fora" } };
    const r = await processarWebhookMeta(adminFalso(), SESSAO, semIdentidade() as never, "req-1");
    expect(r.desfechos).toEqual(["sem_identidade"]);
    expect(estado.logs.some((l) => l.msg.includes("falhou"))).toBe(true);
  });
});
