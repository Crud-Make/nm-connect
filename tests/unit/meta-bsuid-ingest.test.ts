import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestMetaEcho, ingestMetaInbound } from "@/lib/channels/meta/ingest";
import {
  parseMetaWebhook,
  type InboundMessageEvent,
  type OutboundEchoEvent,
} from "@/lib/channels/meta/webhook";

/**
 * A INGESTÃO PELO BSUID — o contato que nasce sem telefone e o ganha depois.
 *
 * O que este arquivo prova é o lado TypeScript: que a ingestão escolhe a
 * resolução certa e entrega a ela os dados certos. Quem decide se o contato é
 * o mesmo, se junta duas fichas e onde o BSUID fica é o banco
 * (`fn_upsert_meta_contact`, migration 0678), provado contra Postgres de
 * verdade em `tests/invariants/meta-bsuid-identidade.test.ts`. Um mock de RPC
 * que "junta fichas" só provaria o mock.
 */
const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  insert: null as Record<string, unknown> | null,
  internos: [] as string[],
  buscasPorTelefone: [] as string[],
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async (_a: unknown, _o: string, tel: string) => {
    estado.buscasPorTelefone.push(tel);
    return null;
  },
}));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: async () => undefined }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: async () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async (_db: unknown, _org: string, p: { phone: string | null }) => {
    if (p.phone) estado.internos.push(p.phone);
    return false;
  },
  registrarMensagemIgnorada: async () => undefined,
}));

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: { id: "session-1", organization_id: "org-1" }, error: null }),
      };
      return chain;
    }
    if (table === "messages") {
      return {
        insert: (payload: Record<string, unknown>) => {
          estado.insert = payload;
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "message-1" }, error: null }) }) };
        },
      };
    }
    if (table === "conversations") {
      const chain: Record<string, unknown> = {
        update: () => chain,
        eq: () => chain,
        select: () => chain,
        maybeSingle: async () => ({ data: { id: "conversation-1" }, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }),
      };
      return chain;
    }
    throw new Error(`tabela inesperada: ${table}`);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_upsert_wa_contact" || name === "fn_upsert_meta_contact") {
      return { data: "contact-1", error: null };
    }
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const DOC = JSON.parse(readFileSync("tests/fixtures/meta/bsuid-da-doc.json", "utf8")) as Record<
  string,
  Parameters<typeof parseMetaWebhook>[0]
>;
const recebida = (nome: string) =>
  parseMetaWebhook(DOC[nome]!).find((e): e is InboundMessageEvent => e.kind === "inbound_message")!;
const BSUID = "US.13491208655302741918";
const contatoRpc = () =>
  estado.rpcs.find((r) => r.name === "fn_upsert_meta_contact" || r.name === "fn_upsert_wa_contact");

beforeEach(() => {
  estado.rpcs = [];
  estado.insert = null;
  estado.internos = [];
  estado.buscasPorTelefone = [];
});

describe("mensagem recebida só com BSUID", () => {
  it("⭐ vira contato, conversa e mensagem — o lead novo de anúncio não some mais", async () => {
    const r = await ingestMetaInbound(adminFalso(), recebida("mensagem_so_bsuid"), {
      organizationId: "org-1",
    });
    expect(r).toEqual({ status: "ingested", messageId: "message-1", conversationId: "conversation-1" });
    expect(contatoRpc()).toEqual({
      name: "fn_upsert_meta_contact",
      args: {
        p_org: "org-1",
        p_bsuid: BSUID,
        p_username: "realsheenanelson",
        p_phone: null,
        p_chat_id: null,
        p_notify: "Sheena Nelson",
      },
    });
    expect(estado.insert).toMatchObject({ direction: "inbound", body: "Does it come in another color?" });
  });

  it("sem telefone não há número interno para comparar nem variante para buscar", async () => {
    await ingestMetaInbound(adminFalso(), recebida("mensagem_so_bsuid"), { organizationId: "org-1" });
    expect(estado.internos).toEqual([]);
    expect(estado.buscasPorTelefone).toEqual([]);
  });
});

describe("mensagem recebida com telefone E BSUID", () => {
  it("o telefone canônico e o BSUID vão juntos para o banco decidir quem é", async () => {
    await ingestMetaInbound(adminFalso(), recebida("mensagem_telefone_e_bsuid"), {
      organizationId: "org-1",
    });
    expect(contatoRpc()).toEqual({
      name: "fn_upsert_meta_contact",
      args: {
        p_org: "org-1",
        p_bsuid: BSUID,
        p_username: "realsheenanelson",
        p_phone: "+16505551234",
        p_chat_id: "16505551234",
        p_notify: "Sheena Nelson",
      },
    });
    // A guarda do número interno continua valendo quando HÁ telefone.
    expect(estado.internos).toEqual(["+16505551234"]);
  });
});

describe("mensagem recebida só com telefone (antes dos usernames)", () => {
  it("o caminho de sempre, sem RPC nova", async () => {
    const e: InboundMessageEvent = {
      ...recebida("mensagem_telefone_e_bsuid"),
      fromUserId: undefined,
      username: undefined,
    };
    delete e.fromUserId;
    delete e.username;
    await ingestMetaInbound(adminFalso(), e, { organizationId: "org-1" });
    expect(contatoRpc()).toEqual({
      name: "fn_upsert_wa_contact",
      args: {
        p_org: "org-1",
        p_kind: "phone",
        p_phone: "+16505551234",
        p_lid: null,
        p_chat_id: "16505551234",
        p_notify: "Sheena Nelson",
      },
    });
  });
});

describe("o telefone que chega pelo REQUEST_CONTACT_INFO", () => {
  it("entra como o telefone do contato do BSUID — é o que junta as fichas", async () => {
    await ingestMetaInbound(adminFalso(), recebida("contatos_request_contact_info"), {
      organizationId: "org-1",
    });
    expect(contatoRpc()).toMatchObject({
      name: "fn_upsert_meta_contact",
      args: { p_bsuid: BSUID, p_phone: "+16505551234", p_chat_id: null },
    });
    // O número informado passa pela mesma guarda do número interno.
    expect(estado.internos).toEqual(["+16505551234"]);
  });
});

describe("eco do app com BSUID", () => {
  const eco = (semTelefone: boolean): OutboundEchoEvent => {
    const env = JSON.parse(JSON.stringify(DOC.eco_smb)) as Parameters<typeof parseMetaWebhook>[0];
    const v = env!.entry![0]!.changes![0]!.value as { message_echoes: Record<string, unknown>[] };
    if (semTelefone) delete v.message_echoes[0]!.to;
    return parseMetaWebhook(env).find((e): e is OutboundEchoEvent => e.kind === "outbound_echo")!;
  };

  it("sem telefone: o destinatário é resolvido pelo BSUID, sem nome inventado", async () => {
    const r = await ingestMetaEcho(adminFalso(), eco(true), { organizationId: "org-1" });
    expect(r.status).toBe("ingested");
    expect(contatoRpc()).toEqual({
      name: "fn_upsert_meta_contact",
      args: {
        p_org: "org-1",
        p_bsuid: BSUID,
        p_username: "realsheenanelson",
        p_phone: null,
        p_chat_id: null,
        // O eco não traz o perfil do CLIENTE — mesma regra do eco por telefone.
        p_notify: null,
      },
    });
    expect(estado.insert).toMatchObject({ direction: "outbound", sent_via: "external_device" });
  });

  it("com telefone e BSUID: os dois vão juntos", async () => {
    await ingestMetaEcho(adminFalso(), eco(false), { organizationId: "org-1" });
    expect(contatoRpc()).toMatchObject({
      name: "fn_upsert_meta_contact",
      args: { p_bsuid: BSUID, p_phone: "+16505551234", p_chat_id: "16505551234" },
    });
  });
});
