import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { filtrosAuxiliaresDaContagem } from "@/app/api/v1/conversations/counts/route";
import { filtrosAuxiliaresAtivos } from "@/lib/inbox/filtros-ativos";
import { listConversationsQuerySchema } from "@/lib/schemas";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";

/**
 * O filtro "Setor" da inbox (migration 0675), ponta a ponta sem banco:
 * schema aceita → handler filtra no banco → badge conta o mesmo → a lista
 * nomeia o filtro ligado. A rota ler a chave é cobrado por
 * `rota-le-todo-filtro-do-schema.test.ts`, que varre o schema.
 */
const SETOR = "55555555-5555-4555-8555-555555555555";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}
function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}
const ctx = { organization_id: "org-1", requestId: "req-1", actor: { type: "user" as const, id: "user-1" } } as never;
async function listar(query: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas.filter((c) => c.tabela === "conversations");
}

describe("filtro de setor na inbox", () => {
  it("o schema aceita uuid e recusa o que não é", () => {
    expect(listConversationsQuerySchema.safeParse({ setor_id: SETOR }).success).toBe(true);
    expect(listConversationsQuerySchema.safeParse({ setor_id: "tributario" }).success).toBe(false);
  });

  it("com setor, a consulta pede ao banco só as conversas do setor", async () => {
    const c = await listar({ setor_id: SETOR });
    expect(c.filter((x) => x.metodo === "eq").map((x) => x.args.join(":"))).toContain(`setor_id:${SETOR}`);
  });

  it("CONTROLE: sem setor, nenhum predicado de setor", async () => {
    const c = await listar({});
    expect(c.some((x) => x.metodo === "eq" && x.args[0] === "setor_id")).toBe(false);
  });

  it("a lista traz o setor_id de cada conversa (a tela nomeia o setor)", async () => {
    const c = await listar({});
    const select = c.find((x) => x.metodo === "select");
    expect(String(select?.args[0])).toMatch(/\bsetor_id\b/);
  });

  it("o badge conta com o MESMO filtro de setor que a lista aplica", () => {
    expect(filtrosAuxiliaresDaContagem(new URLSearchParams(`setor_id=${SETOR}`))).toContainEqual(["setor_id", SETOR]);
  });

  it("a lista nomeia o filtro de setor ligado", () => {
    expect(filtrosAuxiliaresAtivos({ setor_id: SETOR } as ConversationsFilters)).toEqual(["Setor"]);
  });
});
