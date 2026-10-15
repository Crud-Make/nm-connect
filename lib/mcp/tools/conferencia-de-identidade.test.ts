import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: vi.fn() }));
vi.mock("@/lib/external-db/conferencia-de-cpf", async () => {
  const real = (await vi.importActual("@/lib/external-db/conferencia-de-cpf")) as Record<string, unknown>;
  return {
    ...real,
    conexoesQueExigemCpf: vi.fn(),
    telefoneDoContato: vi.fn(),
    conferirCpfNoBancoExterno: vi.fn(),
    lerConferencia: vi.fn(),
    gravarConferencia: vi.fn(),
    avisarCentralDoBloqueio: vi.fn(),
  };
});

import { abrirAcesso } from "@/lib/external-db/acesso";
import {
  avisarCentralDoBloqueio,
  conexoesQueExigemCpf,
  conferirCpfNoBancoExterno,
  gravarConferencia,
  lerConferencia,
  telefoneDoContato,
  type EstadoDaConferencia,
} from "@/lib/external-db/conferencia-de-cpf";
import type { ConexaoExterna } from "@/lib/external-db/types";
import type { McpContext } from "@/lib/mcp/types";

import { crmConfirmCustomerIdentity } from "./conferencia-de-identidade";

const CONEXAO: ConexaoExterna = {
  id: "conn-1",
  organizationId: "org-1",
  label: "Processos",
  host: "db.exemplo.com",
  port: 5432,
  database: "processos",
  username: "crm_leitor",
  password: "segredo",
  sslMode: "require",
  maxRows: 200,
  maxFilters: 20,
  maxResponseBytes: 30_000,
  chaveDoCliente: { coluna: "telefone", tipo: "phone" },
  exigeConferenciaDeCpf: true,
  versao: "2026-10-15T00:00:00.000Z",
};

function ctx(contatoDoTurno: string | null = "contato-1"): McpContext {
  return {
    organizationId: "org-1",
    role: "ai_operator",
    actor: { type: "ai_agent", id: "agente-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: {} as never,
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as unknown as McpContext;
}

/** O estado guardado no CRM, em memória — o que `gravar` escreve, `ler` devolve. */
let guardado: EstadoDaConferencia | null = null;

beforeEach(() => {
  guardado = null;
  vi.mocked(abrirAcesso).mockReset().mockResolvedValue({ ok: true, conexao: CONEXAO, pool: {} as never });
  vi.mocked(conexoesQueExigemCpf).mockReset().mockResolvedValue([{ id: "conn-1", label: "Processos" }]);
  vi.mocked(telefoneDoContato).mockReset().mockResolvedValue("+5531988887777");
  vi.mocked(conferirCpfNoBancoExterno).mockReset().mockResolvedValue(false);
  vi.mocked(lerConferencia).mockReset().mockImplementation(async () => guardado);
  vi.mocked(gravarConferencia)
    .mockReset()
    .mockImplementation(async (_s, _o, _c, _x, estado) => {
      guardado = estado;
    });
  vi.mocked(avisarCentralDoBloqueio).mockReset().mockResolvedValue(undefined);
});

const chamar = (digitos: string, c: McpContext = ctx()) =>
  crmConfirmCustomerIdentity.handler({ digitos }, c) as Promise<Record<string, unknown>>;

describe("crm_confirm_customer_identity — contrato", () => {
  it("o único parâmetro é `digitos`, e só aceita exatamente 3 números", () => {
    expect(Object.keys(crmConfirmCustomerIdentity.inputSchema)).toEqual(["digitos"]);
    const schema = z.object(crmConfirmCustomerIdentity.inputSchema);
    expect(schema.safeParse({ digitos: "123" }).success).toBe(true);
    for (const ruim of ["12", "1234", "12a", "", "1 3", "123.456.789-00"]) {
      expect(schema.safeParse({ digitos: ruim }).success, ruim).toBe(false);
    }
    // Telefone vindo do modelo não existe no contrato: o Zod do runtime o descarta.
    expect(schema.parse({ digitos: "123", telefone: "+5511000000000" })).toEqual({ digitos: "123" });
  });

  it("é escrita (grava a tentativa), só do agente (nenhuma pessoa tem o papel), e os dígitos não vão ao audit", () => {
    expect(crmConfirmCustomerIdentity.category).toBe("write");
    expect(crmConfirmCustomerIdentity.requiresRole).toBe("ai_operator");
    expect(crmConfirmCustomerIdentity.requiresScope).toBe("mcp:write");
    expect(crmConfirmCustomerIdentity.redigirParaAuditoria?.({ digitos: "123" })).toEqual({
      digitos: "[redigido]",
    });
  });

  it("a descrição ensina o modelo: quando pedir, não repetir, não dizer qual dígito errou", () => {
    const d = crmConfirmCustomerIdentity.description;
    expect(d).toContain("3 últimos dígitos do CPF");
    expect(d).toContain("crm_query_external_data");
    expect(d.toLowerCase()).toContain("nunca repita os dígitos");
    expect(d.toLowerCase()).toContain("qual dígito");
  });
});

describe("crm_confirm_customer_identity — conferência", () => {
  it("o telefone é o do CONTATO DO TURNO, lido pelo servidor — nunca do modelo", async () => {
    vi.mocked(conferirCpfNoBancoExterno).mockResolvedValue(true);
    await chamar("123");
    expect(telefoneDoContato).toHaveBeenCalledWith(expect.anything(), "org-1", "contato-1");
    expect(conferirCpfNoBancoExterno).toHaveBeenCalledWith(expect.anything(), "+5531988887777", "123");
  });

  it("confere: libera por 24h e devolve só booleano — sem CPF, sem telefone, sem os dígitos", async () => {
    vi.mocked(conferirCpfNoBancoExterno).mockResolvedValue(true);
    const r = await chamar("123");
    expect(r.confere).toBe(true);
    expect(guardado?.verificadoAte).toBeInstanceOf(Date);
    const texto = JSON.stringify(r);
    expect(texto).not.toContain("123");
    expect(texto).not.toContain("5531988887777");
    expect(Object.keys(r).sort()).toEqual(["confere", "mensagem"]);
  });

  it("não confere: conta a tentativa e devolve só booleano + quantas restam", async () => {
    const r = await chamar("999");
    expect(r).toMatchObject({ confere: false, tentativas_restantes: 2 });
    expect(Object.keys(r).sort()).toEqual(["confere", "mensagem", "tentativas_restantes"]);
    expect(JSON.stringify(r)).not.toContain("999");
    expect(avisarCentralDoBloqueio).not.toHaveBeenCalled();
  });

  it("3 erros bloqueiam, abrem aviso na Central e mandam passar para a equipe", async () => {
    await chamar("111");
    await chamar("222");
    const r = await chamar("333");
    expect(r).toMatchObject({ confere: false, tentativas_restantes: 0, bloqueado: true });
    expect(String(r.mensagem)).toContain("equipe");
    expect(String(r.mensagem)).toContain("request_human_handoff");
    expect(avisarCentralDoBloqueio).toHaveBeenCalledTimes(1);
    expect(avisarCentralDoBloqueio).toHaveBeenCalledWith(expect.anything(), "org-1", "contato-1");
    expect(guardado?.bloqueadoAte).toBeInstanceOf(Date);
  });

  it("bloqueado: nem consulta o banco externo (sem força bruta), e não reabre o aviso", async () => {
    guardado = { verificadoAte: null, tentativasFalhas: 3, bloqueadoAte: new Date(Date.now() + 60_000) };
    vi.mocked(conferirCpfNoBancoExterno).mockResolvedValue(true);
    const r = await chamar("123");
    expect(r).toMatchObject({ confere: false, bloqueado: true, tentativas_restantes: 0 });
    expect(conferirCpfNoBancoExterno).not.toHaveBeenCalled();
    expect(avisarCentralDoBloqueio).not.toHaveBeenCalled();
  });

  it("já conferido e válido: confirma sem consultar de novo", async () => {
    guardado = { verificadoAte: new Date(Date.now() + 60_000), tentativasFalhas: 0, bloqueadoAte: null };
    const r = await chamar("000");
    expect(r.confere).toBe(true);
    expect(conferirCpfNoBancoExterno).not.toHaveBeenCalled();
  });

  it("validade vencida: volta a conferir no banco", async () => {
    guardado = { verificadoAte: new Date(Date.now() - 1), tentativasFalhas: 0, bloqueadoAte: null };
    vi.mocked(conferirCpfNoBancoExterno).mockResolvedValue(true);
    const r = await chamar("123");
    expect(r.confere).toBe(true);
    expect(conferirCpfNoBancoExterno).toHaveBeenCalledTimes(1);
  });

  it("fora da conversa (integrador, pessoa): recusa — não há de quem conferir", async () => {
    const r = await chamar("123", ctx(null));
    expect(r.erro).toBe("fora_da_conversa");
    expect(conferirCpfNoBancoExterno).not.toHaveBeenCalled();
  });

  it("contato sem telefone: recusa sem consultar e sem gastar tentativa", async () => {
    vi.mocked(telefoneDoContato).mockResolvedValue(null);
    const r = await chamar("123");
    expect(r.erro).toBe("cliente_sem_telefone");
    expect(conferirCpfNoBancoExterno).not.toHaveBeenCalled();
    expect(gravarConferencia).not.toHaveBeenCalled();
  });

  it("nenhuma conexão exige conferência: diz isso em vez de inventar", async () => {
    vi.mocked(conexoesQueExigemCpf).mockResolvedValue([]);
    const r = await chamar("123");
    expect(r.erro).toBe("conferencia_nao_exigida");
  });

  it("falha do banco externo: não conta como erro do cliente", async () => {
    vi.mocked(conferirCpfNoBancoExterno).mockRejectedValue(new Error("timeout"));
    const r = await chamar("123");
    expect(r.erro).toBe("falha_na_conferencia");
    expect(gravarConferencia).not.toHaveBeenCalled();
  });
});
