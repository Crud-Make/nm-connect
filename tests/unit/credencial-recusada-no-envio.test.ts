/**
 * Token recusado NO ENVIO vira estado da conexão na tela — pelo mecanismo que
 * já existe, não por um paralelo.
 *
 * O vigia de saúde (`cron/channel-health`) faz isto a cada rodada: grava
 * `channel_sessions.status` e chama `sincronizarSaudeDaConexao`, que abre o
 * aviso na Central (`agent_inbox_items`) uma vez por episódio e alimenta a faixa
 * de "conexão caída" (`listarConexoesCaidas`, que lê o mesmo `status`). O envio
 * que recebe 190 sabe disso ANTES da próxima rodada; aqui ele usa o mesmo
 * caminho, e o vigia segue sendo quem fecha o episódio quando o token volta.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { registrarCredencialRecusadaNoEnvio } from "@/lib/channels/credencial-recusada-no-envio";
import { avisoDaConexao, DETALHE_TOKEN_RECUSADO_NO_ENVIO } from "@/lib/channels/health";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSION = "44444444-4444-4444-8444-444444444444";

type Op = { tabela: string; op: string; valor?: unknown; filtros: Record<string, unknown> };

function adminFalso(opts: { sessao: Record<string, unknown> | null; escalado?: string | null }) {
  const ops: Op[] = [];
  const admin = {
    from(tabela: string) {
      const registro: Op = { tabela, op: "select", filtros: {} };
      const cadeia: Record<string, unknown> = {};
      cadeia.select = () => cadeia;
      cadeia.eq = (c: string, v: unknown) => {
        registro.filtros[c] = v;
        return cadeia;
      };
      cadeia.is = () => cadeia;
      cadeia.update = (valor: unknown) => {
        registro.op = "update";
        registro.valor = valor;
        ops.push(registro);
        return cadeia;
      };
      cadeia.insert = async (valor: unknown) => {
        ops.push({ tabela, op: "insert", valor, filtros: {} });
        return { data: null, error: null };
      };
      cadeia.upsert = async (valor: unknown) => {
        ops.push({ tabela, op: "upsert", valor, filtros: {} });
        return { data: null, error: null };
      };
      cadeia.maybeSingle = async () => {
        if (tabela === "channel_sessions") return { data: opts.sessao, error: null };
        if (tabela === "channel_session_health")
          return { data: { escalated_status: opts.escalado ?? null }, error: null };
        return { data: null, error: null };
      };
      cadeia.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(ok);
      return cadeia;
    },
  };
  return { admin: admin as unknown as SupabaseClient, ops };
}

describe("registrarCredencialRecusadaNoEnvio", () => {
  it("marca a sessão FAILED (com o tenant no filtro) e abre UM aviso crítico na Central", async () => {
    const { admin, ops } = adminFalso({
      sessao: {
        id: SESSION,
        organization_id: ORG,
        status: "WORKING",
        display_name: "Recepção",
        phone_number: null,
      },
    });

    const r = await registrarCredencialRecusadaNoEnvio(
      { organizationId: ORG, channelSessionId: SESSION },
      admin,
    );

    expect(r).toBe("avisado");
    const status = ops.find((o) => o.tabela === "channel_sessions" && o.op === "update");
    expect(status?.valor).toMatchObject({ status: "FAILED" });
    expect(status?.filtros).toMatchObject({ id: SESSION, organization_id: ORG });
    const aviso = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "insert");
    expect(aviso?.valor).toMatchObject({
      organization_id: ORG,
      kind: "channel_number_alert",
      severity: "critical",
      ref_kind: "channel_session",
      ref_id: SESSION,
    });
    expect(String((aviso?.valor as { title: string }).title)).toMatch(/Recepção/);
    expect(String((aviso?.valor as { title: string }).title)).toMatch(/token/i);
  });

  it("episódio já avisado (o vigia viu antes): não repete o aviso", async () => {
    const { admin, ops } = adminFalso({
      sessao: {
        id: SESSION,
        organization_id: ORG,
        status: "FAILED",
        display_name: null,
        phone_number: "+5531",
      },
      escalado: "FAILED",
    });

    expect(
      await registrarCredencialRecusadaNoEnvio(
        { organizationId: ORG, channelSessionId: SESSION },
        admin,
      ),
    ).toBe("ja_avisado");
    expect(ops.some((o) => o.tabela === "agent_inbox_items")).toBe(false);
    // Já estava FAILED: não reescreve o status (nem o carimbo de mudança).
    expect(ops.some((o) => o.tabela === "channel_sessions" && o.op === "update")).toBe(false);
  });

  it("sessão de outra organização (ou inexistente): não toca em nada", async () => {
    const { admin, ops } = adminFalso({ sessao: null });
    expect(
      await registrarCredencialRecusadaNoEnvio(
        { organizationId: ORG, channelSessionId: SESSION },
        admin,
      ),
    ).toBe("sem_sessao");
    expect(ops).toEqual([]);
  });
});

describe("avisoDaConexao — token recusado no envio", () => {
  it("mesmo episódio do vigia (FAILED), texto que diz o que fazer", () => {
    const a = avisoDaConexao(
      { reachable: true, status: "FAILED", detail: DETALHE_TOKEN_RECUSADO_NO_ENVIO },
      "Loja",
    );
    expect(a?.episodio).toBe("FAILED");
    expect(a?.severity).toBe("critical");
    expect(a?.body).toMatch(/Conexões/);
  });
});
