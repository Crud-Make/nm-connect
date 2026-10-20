import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./conexao", () => ({ consultar: vi.fn() }));

import { consultar } from "./conexao";
import {
  aplicarResultado,
  BLOQUEIO_APOS_ERROS_MS,
  conferirCpfDoContato,
  conferirCpfNoBancoExterno,
  FUNCAO_DE_CONFERENCIA,
  gravarConferencia,
  lerConferencia,
  MAX_TENTATIVAS,
  situacaoDaConferencia,
  telefoneParaConferencia,
  VALIDADE_DA_CONFERENCIA_MS,
  type EstadoDaConferencia,
} from "./conferencia-de-cpf";

const AGORA = new Date("2026-10-15T12:00:00.000Z");
const depois = (ms: number) => new Date(AGORA.getTime() + ms);
const antes = (ms: number) => new Date(AGORA.getTime() - ms);

const LIMPO: EstadoDaConferencia = { verificadoAte: null, tentativasFalhas: 0, bloqueadoAte: null };

describe("situacaoDaConferencia", () => {
  it("sem linha: pendente, com todas as tentativas", () => {
    expect(situacaoDaConferencia(null, AGORA)).toEqual({ tipo: "pendente", tentativasRestantes: MAX_TENTATIVAS });
  });

  it("conferido dentro da validade: verificado", () => {
    const e = { ...LIMPO, verificadoAte: depois(60_000) };
    expect(situacaoDaConferencia(e, AGORA).tipo).toBe("verificado");
  });

  it("a validade EXPIRA: depois dela volta a pendente", () => {
    const e = { ...LIMPO, verificadoAte: antes(1) };
    expect(situacaoDaConferencia(e, AGORA)).toEqual({ tipo: "pendente", tentativasRestantes: MAX_TENTATIVAS });
  });

  it("bloqueado vence verificado", () => {
    const e = { verificadoAte: depois(60_000), tentativasFalhas: 3, bloqueadoAte: depois(1_000) };
    expect(situacaoDaConferencia(e, AGORA).tipo).toBe("bloqueado");
  });

  it("bloqueio vencido zera as tentativas", () => {
    const e = { ...LIMPO, tentativasFalhas: 3, bloqueadoAte: antes(1) };
    expect(situacaoDaConferencia(e, AGORA)).toEqual({ tipo: "pendente", tentativasRestantes: MAX_TENTATIVAS });
  });

  it("conta as tentativas que restam", () => {
    const e = { ...LIMPO, tentativasFalhas: 2 };
    expect(situacaoDaConferencia(e, AGORA)).toEqual({ tipo: "pendente", tentativasRestantes: 1 });
  });
});

describe("aplicarResultado", () => {
  it("acerto: verificado por 24h e zera os erros", () => {
    const r = aplicarResultado({ ...LIMPO, tentativasFalhas: 2 }, true, AGORA);
    expect(VALIDADE_DA_CONFERENCIA_MS).toBe(24 * 60 * 60 * 1000);
    expect(r.novo).toEqual({ verificadoAte: depois(VALIDADE_DA_CONFERENCIA_MS), tentativasFalhas: 0, bloqueadoAte: null });
    expect(r.situacao.tipo).toBe("verificado");
    expect(r.acabouDeBloquear).toBe(false);
  });

  it("erro: soma e informa quantas restam", () => {
    const r = aplicarResultado(null, false, AGORA);
    expect(r.novo.tentativasFalhas).toBe(1);
    expect(r.situacao).toEqual({ tipo: "pendente", tentativasRestantes: MAX_TENTATIVAS - 1 });
    expect(r.acabouDeBloquear).toBe(false);
  });

  it("3 erros bloqueiam por 24h", () => {
    let estado: EstadoDaConferencia | null = null;
    let ultimo = aplicarResultado(estado, false, AGORA);
    for (let i = 1; i < MAX_TENTATIVAS; i += 1) {
      estado = ultimo.novo;
      ultimo = aplicarResultado(estado, false, AGORA);
    }
    expect(MAX_TENTATIVAS).toBe(3);
    expect(BLOQUEIO_APOS_ERROS_MS).toBe(24 * 60 * 60 * 1000);
    expect(ultimo.acabouDeBloquear).toBe(true);
    expect(ultimo.novo.bloqueadoAte).toEqual(depois(BLOQUEIO_APOS_ERROS_MS));
    expect(ultimo.novo.verificadoAte).toBeNull();
    expect(ultimo.situacao.tipo).toBe("bloqueado");
  });

  it("erro depois de bloqueio vencido recomeça a contagem", () => {
    const r = aplicarResultado({ ...LIMPO, tentativasFalhas: 3, bloqueadoAte: antes(1) }, false, AGORA);
    expect(r.novo.tentativasFalhas).toBe(1);
    expect(r.novo.bloqueadoAte).toBeNull();
    expect(r.acabouDeBloquear).toBe(false);
  });
});

describe("telefoneParaConferencia", () => {
  it("devolve E.164 com +, só dígitos", () => {
    expect(telefoneParaConferencia("+55 (11) 99999-8888")).toBe("+5511999998888");
    expect(telefoneParaConferencia("5511999998888")).toBe("+5511999998888");
  });
  it("vazio vira null", () => {
    expect(telefoneParaConferencia(null)).toBeNull();
    expect(telefoneParaConferencia("  ")).toBeNull();
  });
});

describe("conferirCpfNoBancoExterno", () => {
  beforeEach(() => vi.mocked(consultar).mockReset());

  it("chama a função FIXA, parametrizada — telefone e dígitos nunca no texto do SQL", async () => {
    vi.mocked(consultar).mockResolvedValue({ rows: [{ confere: true }] } as never);
    const r = await conferirCpfNoBancoExterno({} as never, "+5511999998888", "123");
    expect(r).toBe(true);
    const [, texto, valores] = vi.mocked(consultar).mock.calls[0]!;
    expect(FUNCAO_DE_CONFERENCIA).toBe("ia.conferir_cpf");
    expect(texto).toBe("select ia.conferir_cpf($1::text, $2::text) as confere");
    expect(texto).not.toContain("5511999998888");
    expect(texto).not.toContain("123");
    expect(valores).toEqual(["+5511999998888", "123"]);
  });

  it("qualquer coisa que não seja true é NÃO confere (null, linha ausente)", async () => {
    vi.mocked(consultar).mockResolvedValue({ rows: [{ confere: null }] } as never);
    expect(await conferirCpfNoBancoExterno({} as never, "+5511999998888", "123")).toBe(false);
    vi.mocked(consultar).mockResolvedValue({ rows: [] } as never);
    expect(await conferirCpfNoBancoExterno({} as never, "+5511999998888", "123")).toBe(false);
  });
});

/** Cliente falso que grava a cadeia de filtros de uma leitura e o corpo de um upsert/rpc. */
function clienteQueGrava(resposta: { data: unknown; error: { message: string } | null }) {
  const filtros: Array<[string, string, unknown]> = [];
  const upserts: Array<{ linha: Record<string, unknown>; opcoes: unknown }> = [];
  const rpcs: Array<{ nome: string; args: unknown }> = [];
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), consulta),
    is: (coluna: string, valor: unknown) => (filtros.push(["is", coluna, valor]), consulta),
    maybeSingle: async () => resposta,
  };
  const supabase = {
    from: () => ({
      ...consulta,
      upsert: async (linha: Record<string, unknown>, opcoes: unknown) => {
        upserts.push({ linha, opcoes });
        return { error: resposta.error };
      },
    }),
    rpc: async (nome: string, args: unknown) => (rpcs.push({ nome, args }), resposta),
  };
  return { supabase: supabase as never, filtros, upserts, rpcs };
}

describe("lerConferencia / gravarConferencia — a conexão nula é o cadastro do contato (0706)", () => {
  it("com conexão, filtra connection_id por igualdade (o caminho do banco externo, inalterado)", async () => {
    const c = clienteQueGrava({ data: null, error: null });
    expect(await lerConferencia(c.supabase, "org-1", "ct-1", "conn-1")).toBeNull();
    expect(c.filtros).toContainEqual(["eq", "connection_id", "conn-1"]);
    expect(c.filtros.some(([op]) => op === "is")).toBe(false);
  });

  it("sem conexão, filtra connection_id IS NULL — `= null` não casaria linha nenhuma", async () => {
    const c = clienteQueGrava({
      data: { verificado_ate: null, tentativas_falhas: 2, bloqueado_ate: null },
      error: null,
    });
    expect(await lerConferencia(c.supabase, "org-1", "ct-1", null)).toEqual({
      verificadoAte: null,
      tentativasFalhas: 2,
      bloqueadoAte: null,
    });
    expect(c.filtros).toContainEqual(["is", "connection_id", null]);
    expect(c.filtros).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(c.filtros.some(([op, coluna]) => op === "eq" && coluna === "connection_id")).toBe(false);
  });

  it("grava a linha de conexão nula pela mesma chave de conflito", async () => {
    const c = clienteQueGrava({ data: null, error: null });
    await gravarConferencia(c.supabase, "org-1", "ct-1", null, LIMPO);
    expect(c.upserts[0]!.linha).toMatchObject({ organization_id: "org-1", contact_id: "ct-1", connection_id: null });
    expect(c.upserts[0]!.opcoes).toEqual({ onConflict: "organization_id,contact_id,connection_id" });
  });
});

describe("conferirCpfDoContato", () => {
  it("pergunta ao banco por rpc e devolve o boolean dele — os dígitos só como argumento", async () => {
    const c = clienteQueGrava({ data: true, error: null });
    expect(await conferirCpfDoContato(c.supabase, "org-1", "ct-1", "123")).toBe(true);
    expect(c.rpcs).toEqual([
      { nome: "fn_conferir_cpf_do_contato", args: { p_org: "org-1", p_contato: "ct-1", p_digitos: "123" } },
    ]);
    expect(await conferirCpfDoContato(clienteQueGrava({ data: false, error: null }).supabase, "o", "c", "1")).toBe(false);
  });

  it("contato sem CPF (null do banco) volta null — não é 'não confere'", async () => {
    expect(await conferirCpfDoContato(clienteQueGrava({ data: null, error: null }).supabase, "o", "c", "123")).toBeNull();
  });

  it("erro do banco LANÇA: não pode virar tentativa errada", async () => {
    const c = clienteQueGrava({ data: null, error: { message: "boom" } });
    await expect(conferirCpfDoContato(c.supabase, "o", "c", "123")).rejects.toThrow(/conferir_cpf_do_contato_falhou/);
  });
});
