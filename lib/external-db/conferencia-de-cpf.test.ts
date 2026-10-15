import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./conexao", () => ({ consultar: vi.fn() }));

import { consultar } from "./conexao";
import {
  aplicarResultado,
  BLOQUEIO_APOS_ERROS_MS,
  conferirCpfNoBancoExterno,
  FUNCAO_DE_CONFERENCIA,
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
