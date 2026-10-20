import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/external-db/conferencia-de-cpf", async () => {
  const real = (await vi.importActual("@/lib/external-db/conferencia-de-cpf")) as Record<string, unknown>;
  return {
    ...real,
    conferirCpfDoContato: vi.fn(),
    lerConferencia: vi.fn(),
    gravarConferencia: vi.fn(),
    avisarCentralDoBloqueio: vi.fn(),
  };
});

import {
  avisarCentralDoBloqueio,
  conferirCpfDoContato,
  gravarConferencia,
  lerConferencia,
  type EstadoDaConferencia,
} from "@/lib/external-db/conferencia-de-cpf";
import type { McpContext } from "@/lib/mcp/types";

import { crmConfirmProcessosIdentity, crmListProcessosDoCliente } from "./processos";

const ORG = "org-1";
const DO_TURNO = "contato-1";
const OUTRO = "contato-2";

type Linha = Record<string, unknown>;

/** O banco em memória: aplica os filtros `eq`/`in` de verdade e lembra o que foi lido. */
function supabaseFalso(tabelas: Record<string, Linha[]>) {
  const lidas: string[] = [];
  const from = (tabela: string) => {
    lidas.push(tabela);
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      order: () => q,
      limit: (n: number) => ((limite = n), q),
      then: (ok: (r: unknown) => unknown) =>
        Promise.resolve({
          data: (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).slice(0, limite),
          error: null,
        }).then(ok),
    };
    return q;
  };
  return { from, lidas };
}

const PROCESSOS: Linha[] = [
  { id: "p1", organization_id: ORG, contact_id: DO_TURNO, apelido: "O divórcio", area: "familia", fase: "conhecimento", numero_cnj: "0000001-00.2026.8.13.0001" },
  { id: "p2", organization_id: ORG, contact_id: OUTRO, apelido: "Do outro", area: "civel", fase: "recurso" },
  { id: "p3", organization_id: "org-2", contact_id: DO_TURNO, apelido: "De outra org", area: "civel", fase: "recurso" },
];
const ANDAMENTOS: Linha[] = [
  { processo_id: "p1", organization_id: ORG, status: "aprovado", texto: "Audiência marcada.", aprovado_em: "2026-10-10T12:00:00Z", criado_por: "u1" },
  { processo_id: "p1", organization_id: ORG, status: "rascunho", texto: "RASCUNHO interno", aprovado_em: null },
  { processo_id: "p2", organization_id: ORG, status: "aprovado", texto: "Do outro cliente", aprovado_em: "2026-10-11T12:00:00Z" },
  { processo_id: "p1", organization_id: "org-2", status: "aprovado", texto: "De outra org", aprovado_em: "2026-10-12T12:00:00Z" },
];

let banco: ReturnType<typeof supabaseFalso>;

function ctx(contatoDoTurno: string | null = DO_TURNO): McpContext {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "agente-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: banco as never,
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as unknown as McpContext;
}

const HORA = 60 * 60 * 1000;
const VERIFICADO: EstadoDaConferencia = { verificadoAte: new Date(Date.now() + HORA), tentativasFalhas: 0, bloqueadoAte: null };
const BLOQUEADO: EstadoDaConferencia = { verificadoAte: null, tentativasFalhas: 3, bloqueadoAte: new Date(Date.now() + HORA) };

let guardado: EstadoDaConferencia | null;

beforeEach(() => {
  guardado = null;
  banco = supabaseFalso({ processos: PROCESSOS, andamentos: ANDAMENTOS });
  vi.mocked(lerConferencia).mockReset().mockImplementation(async () => guardado);
  vi.mocked(gravarConferencia)
    .mockReset()
    .mockImplementation(async (_s, _o, _c, _x, estado) => {
      guardado = estado;
    });
  vi.mocked(conferirCpfDoContato).mockReset().mockResolvedValue(false);
  vi.mocked(avisarCentralDoBloqueio).mockReset().mockResolvedValue(undefined);
});

describe("crm_list_processos_do_cliente", () => {
  const listar = (c = ctx()) => crmListProcessosDoCliente.handler({}, c) as Promise<Record<string, unknown>>;

  it("sem contato do turno recusa, sem ler trava nem processo", async () => {
    expect(await listar(ctx(null))).toMatchObject({ erro: "fora_da_conversa" });
    expect(lerConferencia).not.toHaveBeenCalled();
    expect(banco.lidas).toEqual([]);
  });

  it("sem conferência pede os dígitos e aponta a confirmação de processos", async () => {
    const r = await listar();
    expect(r.erro).toBe("identidade_nao_conferida");
    expect(r.mensagem).toContain("crm_confirm_processos_identity");
    expect(banco.lidas).toEqual([]);
  });

  it("confere na linha do CADASTRO (conexão nula), do contato do turno", async () => {
    await listar();
    expect(lerConferencia).toHaveBeenCalledWith(banco, ORG, DO_TURNO, null);
  });

  it("bloqueada recusa sem dado", async () => {
    guardado = BLOQUEADO;
    expect(await listar()).toMatchObject({ erro: "identidade_bloqueada" });
    expect(banco.lidas).toEqual([]);
  });

  it("verificada traz só o aprovado, só do contato do turno, sem vazar outra organização nem o CNJ", async () => {
    guardado = VERIFICADO;
    expect(await listar()).toEqual({
      processos: [
        {
          apelido: "O divórcio",
          area: "familia",
          fase: "conhecimento",
          andamentos: [{ texto: "Audiência marcada.", aprovado_em: "2026-10-10T12:00:00Z" }],
        },
      ],
    });
  });

  it("verificada e sem processo devolve lista vazia sem ler andamentos", async () => {
    guardado = VERIFICADO;
    banco = supabaseFalso({ processos: [], andamentos: ANDAMENTOS });
    expect(await listar()).toEqual({ processos: [] });
    expect(banco.lidas).toEqual(["processos"]);
  });
});

describe("crm_confirm_processos_identity", () => {
  const confirmar = (c = ctx()) =>
    crmConfirmProcessosIdentity.handler({ digitos: "123" }, c) as Promise<Record<string, unknown>>;

  it("sem contato do turno recusa", async () => {
    expect(await confirmar(ctx(null))).toMatchObject({ erro: "fora_da_conversa" });
    expect(conferirCpfDoContato).not.toHaveBeenCalled();
  });

  it("confere contra o cadastro do contato do turno e grava na linha de conexão nula", async () => {
    vi.mocked(conferirCpfDoContato).mockResolvedValue(true);
    const r = await confirmar();
    expect(conferirCpfDoContato).toHaveBeenCalledWith(banco, ORG, DO_TURNO, "123");
    expect(r).toMatchObject({ confere: true });
    expect(r.mensagem).toContain("crm_list_processos_do_cliente");
    expect(vi.mocked(gravarConferencia).mock.calls[0]?.[3]).toBeNull();
  });

  it("errar gasta tentativa; três erros bloqueiam e avisam a Central", async () => {
    expect(await confirmar()).toMatchObject({ confere: false, tentativas_restantes: 2 });
    await confirmar();
    expect(await confirmar()).toMatchObject({ bloqueado: true });
    expect(avisarCentralDoBloqueio).toHaveBeenCalledWith(banco, ORG, DO_TURNO);
  });

  it("bloqueada não pergunta ao banco", async () => {
    guardado = BLOQUEADO;
    expect(await confirmar()).toMatchObject({ bloqueado: true });
    expect(conferirCpfDoContato).not.toHaveBeenCalled();
  });

  it("contato sem CPF passa para uma pessoa sem gastar tentativa", async () => {
    vi.mocked(conferirCpfDoContato).mockResolvedValue(null);
    const r = await confirmar();
    expect(r.erro).toBe("cliente_sem_cpf");
    expect(r.mensagem).toContain("request_human_handoff");
    expect(gravarConferencia).not.toHaveBeenCalled();
  });

  it("falha do banco não gasta tentativa", async () => {
    vi.mocked(conferirCpfDoContato).mockRejectedValue(new Error("rpc caiu"));
    expect(await confirmar()).toMatchObject({ erro: "falha_na_conferencia" });
    expect(gravarConferencia).not.toHaveBeenCalled();
  });

  it("os dígitos não vão ao audit", () => {
    expect(crmConfirmProcessosIdentity.redigirParaAuditoria?.({ digitos: "123" })).toEqual({ digitos: "[redigido]" });
  });
});
