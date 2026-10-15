/**
 * A mensagem automática presa em `queued` num canal que NÃO tem resgate da fila.
 *
 * O defeito (C3): o único reenvio de `queued` é o watchdog do agent-engine, e
 * ele só alcança o transporte não oficial (filtro de sessão no SQL de
 * `redriveQueued`). Pior: ele só liga quando as credenciais desse transporte
 * estão no env — numa instalação só com o canal oficial, não existe watchdog.
 * Já o `inbound_turn` NÃO reagenda quando o envio volta `queued`: ele diz ao
 * modelo "o canal vai enviar quando a sessão voltar" e encerra o job. Resultado
 * medido no código: a resposta da IA pelo canal oficial que caiu em `queued`
 * (credencial ausente, sessão fora, processo morto no meio do envio) nunca sai
 * e nunca vira falha — o watchdog só a CONTA num warn.
 *
 * A regra escolhida não reenvia (o cron não tem como saber se a plataforma já
 * aceitou uma linha sem id, e envio em dobro é pior que não-envio): marca
 * `failed` com motivo e abre aviso na Central, exatamente como o mesmo cron já
 * faz com `sending`. E só quando a linha NÃO tem dono vivo — o job do
 * follow-up que ainda vai reprocessá-la é dono, e falhá-la brigaria com ele.
 *
 * O dublê aplica os filtros de verdade sobre as linhas, para os casos dizerem o
 * que acontece com CADA mensagem, e não só quais filtros foram escritos.
 */
import { describe, expect, it } from "vitest";

import { STUCK_AFTER_MS, recoverStuckQueued } from "@/app/api/v1/cron/recover-stuck-messages/route";
import { providersSemResgateDaFila } from "@/lib/channels/capabilities";

type Linha = Record<string, unknown>;

interface Chamada {
  tabela: string;
  op: string;
  filtros: Array<[string, string, unknown]>;
  valores?: Linha;
}

function ler(linha: Linha, caminho: string): unknown {
  return caminho.split(".").reduce<unknown>((acc, k) => (acc as Linha | undefined)?.[k], linha);
}

/** Aplica eq/in/is/lt como o PostgREST faria; `or` só no formato que a regra usa. */
function casa(linha: Linha, filtros: Array<[string, string, unknown]>): boolean {
  return filtros.every(([op, col, val]) => {
    const v = ler(linha, col);
    if (op === "eq") return v === val;
    if (op === "in") return (val as unknown[]).includes(v);
    if (op === "is") return v === val || (val === null && v === undefined);
    if (op === "lt") return String(v) < String(val);
    if (op === "or") {
      // "id.in.(a,b),crm_message_id.in.(a,b)"
      return [...String(val).matchAll(/(\w+)\.in\.\(([^)]*)\)/g)].some(([, c, lista]) =>
        (lista ?? "").split(",").includes(String(linha[c ?? ""])),
      );
    }
    throw new Error(`filtro não modelado: ${op}`);
  });
}

function clientDuble(tabelas: { messages: Linha[]; send_ledger?: Linha[]; job_queue?: Linha[] }) {
  const dados: { messages: Linha[]; send_ledger: Linha[]; job_queue: Linha[] } = {
    messages: tabelas.messages,
    send_ledger: tabelas.send_ledger ?? [],
    job_queue: tabelas.job_queue ?? [],
  };
  const chamadas: Chamada[] = [];
  const client = {
    rpc(fn: string, args: Linha) {
      chamadas.push({ tabela: `rpc:${fn}`, op: "rpc", filtros: [], valores: args });
      return Promise.resolve({ error: null });
    },
    from(tabela: string) {
      const filtros: Array<[string, string, unknown]> = [];
      let valores: Linha | undefined;
      let op = "select";
      const executar = () => {
        chamadas.push({ tabela, op, filtros, valores });
        const alvo = ((dados as Record<string, Linha[] | undefined>)[tabela] ?? []).filter((l) =>
          casa(l, filtros),
        );
        if (op === "update") for (const l of alvo) Object.assign(l, valores);
        return { data: alvo.map((l) => ({ ...l })), error: null };
      };
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        update(v: Linha) {
          op = "update";
          valores = v;
          return cadeia;
        },
        insert(v: Linha) {
          chamadas.push({ tabela, op: "insert", filtros: [], valores: v });
          return Promise.resolve({ data: null, error: null });
        },
        eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), cadeia),
        in: (c: string, v: unknown) => (filtros.push(["in", c, v]), cadeia),
        is: (c: string, v: unknown) => (filtros.push(["is", c, v]), cadeia),
        lt: (c: string, v: unknown) => (filtros.push(["lt", c, v]), cadeia),
        or: (v: string) => (filtros.push(["or", "", v]), cadeia),
        limit: () => Promise.resolve(executar()),
        then: (resolve: (r: unknown) => unknown) => Promise.resolve(resolve(executar())),
      };
      return cadeia;
    },
  };
  return { client, chamadas, dados };
}

const AGORA = new Date("2026-10-14T12:00:00.000Z");
const ORG = "22222222-2222-4222-8222-222222222222";
const antes = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();

let seq = 0;
function msg(over: Linha = {}): Linha {
  seq += 1;
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    organization_id: ORG,
    conversation_id: "33333333-3333-4333-8333-333333333333",
    contact_id: "44444444-4444-4444-8444-444444444444",
    direction: "outbound",
    status: "queued",
    sent_via: "ai",
    external_id: null,
    created_at: antes(30),
    metadata: { queued_reason: "meta_not_configured" },
    contacts: { phone_number: "+5531999990000" },
    channel_sessions: { provider: "meta_cloud" },
    ...over,
  };
}

describe("recover-stuck-messages — queued sem resgate", () => {
  it("o canal com resgate da fila fica de fora; os oficiais entram", () => {
    const sem = providersSemResgateDaFila();
    expect(sem).not.toContain("waha");
    expect(sem).toEqual(expect.arrayContaining(["meta_cloud", "datafy", "zernio"]));
  });

  it("Meta queued VELHA e sem dono vira failed com motivo, evento e aviso na Central", async () => {
    const velha = msg();
    const { client, chamadas, dados } = clientDuble({ messages: [velha] });
    const r = await recoverStuckQueued(client as never, AGORA, "req-q1");

    const linha = dados.messages[0]!;
    expect(linha.status).toBe("failed");
    expect(linha.error_code).toBe("queued_timeout");
    // O motivo da fila vai junto: é a primeira pergunta de quem investiga.
    expect(String(linha.error_message)).toContain("meta_not_configured");

    const upd = chamadas.find((c) => c.tabela === "messages" && c.op === "update");
    // Claim atômico: se o dono enviou entre o SELECT e o UPDATE, não toca.
    expect(upd?.filtros).toContainEqual(["eq", "status", "queued"]);
    expect(upd?.filtros).toContainEqual(["eq", "organization_id", ORG]);

    const avisos = chamadas.filter((c) => c.tabela === "agent_inbox_items");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.valores).toMatchObject({ kind: "message_send_stuck", severity: "critical" });
    // Nunca reenvia: o aviso tem de dizer isso, como o de `sending`.
    expect(String(avisos[0]?.valores?.body)).toMatch(/Nada foi reenviado/);

    const [evento] = chamadas.filter((c) => c.tabela === "rpc:emit_event");
    expect(evento?.valores).toMatchObject({
      p_event_type: "message.failed",
      p_entity_id: velha.id,
      p_payload: { erro: { codigo: "queued_timeout" } },
    });
    expect(r).toEqual({ scanned: 1, failed: 1, organizations: 1 });
  });

  it("Meta queued RECENTE não é tocada (o envio pode estar em voo)", async () => {
    const recente = msg({ created_at: antes(1) });
    const { client, chamadas, dados } = clientDuble({ messages: [recente] });
    const r = await recoverStuckQueued(client as never, AGORA, "req-q2");

    expect(dados.messages[0]?.status).toBe("queued");
    const busca = chamadas.find((c) => c.tabela === "messages" && c.op === "select");
    expect(busca?.filtros).toContainEqual([
      "lt",
      "created_at",
      new Date(AGORA.getTime() - STUCK_AFTER_MS).toISOString(),
    ]);
    expect(chamadas.filter((c) => c.op === "insert" || c.op === "rpc")).toEqual([]);
    expect(r.failed).toBe(0);
  });

  it("queued VELHA do canal com resgate (watchdog) segue intocada — o dono dela é outro", async () => {
    const doWatchdog = msg({ channel_sessions: { provider: "waha" }, metadata: {} });
    const { client, dados } = clientDuble({ messages: [doWatchdog] });
    const r = await recoverStuckQueued(client as never, AGORA, "req-q3");

    expect(dados.messages[0]?.status).toBe("queued");
    expect(r.failed).toBe(0);
  });

  it("Meta queued com external_id (wamid) nunca é tocada — a plataforma já aceitou", async () => {
    const aceita = msg({ external_id: "wamid.HBgNNTUzMTk5OTk5MDAwMBUCABEYEjA" });
    const { client, chamadas, dados } = clientDuble({ messages: [aceita] });
    await recoverStuckQueued(client as never, AGORA, "req-q4");

    expect(dados.messages[0]?.status).toBe("queued");
    expect(chamadas.filter((c) => c.op === "update" || c.op === "rpc")).toEqual([]);
  });

  it("send_ledger já 'accepted' para a linha ⇒ não é falha, não é tocada", async () => {
    const m = msg();
    const { client, dados } = clientDuble({
      messages: [m],
      send_ledger: [{ id: m.id, crm_message_id: m.id, job_id: "job-1", status: "accepted" }],
      job_queue: [{ id: "job-1", status: "done" }],
    });
    const r = await recoverStuckQueued(client as never, AGORA, "req-q5");

    expect(dados.messages[0]?.status).toBe("queued");
    expect(r.failed).toBe(0);
  });

  it("com job DONO VIVO (follow-up que vai reprocessar) não é tocada", async () => {
    const m = msg();
    const { client, dados } = clientDuble({
      messages: [m],
      send_ledger: [{ id: m.id, crm_message_id: m.id, job_id: "job-2", status: "queued" }],
      job_queue: [{ id: "job-2", status: "pending" }],
    });
    const r = await recoverStuckQueued(client as never, AGORA, "req-q6");

    expect(dados.messages[0]?.status).toBe("queued");
    expect(r).toEqual({ scanned: 1, failed: 0, organizations: 0 });
  });

  it("dono que já morreu ou terminou (inbound_turn encerrado) não protege: vira failed", async () => {
    const m = msg();
    const { client, dados } = clientDuble({
      messages: [m],
      // ledger ainda 'requested' (processo morto no meio): chave = id da linha
      send_ledger: [{ id: m.id, crm_message_id: null, job_id: "job-3", status: "requested" }],
      job_queue: [{ id: "job-3", status: "done" }],
    });
    const r = await recoverStuckQueued(client as never, AGORA, "req-q7");

    expect(dados.messages[0]?.status).toBe("failed");
    expect(r.failed).toBe(1);
  });

  it("mensagem do atendente (sent_via=user) não entra — ele vê o próprio envio na tela", async () => {
    const humana = msg({ sent_via: "user" });
    const { client, dados } = clientDuble({ messages: [humana] });
    await recoverStuckQueued(client as never, AGORA, "req-q8");
    expect(dados.messages[0]?.status).toBe("queued");
  });
});
