import { describe, expect, it, vi } from "vitest";

import {
  coletarApelidosDeProcesso,
  decidirFormatoDaResposta,
  gerarNotaDeVoz,
  prepararRespostaEmAudio,
  type VozPronta,
} from "./resposta-em-audio";

const ligado = { enabled: true, voice: "cedar", instructions: "Calma." };

describe("decidirFormatoDaResposta — áudio responde áudio, texto responde texto", () => {
  it("cliente mandou nota de voz e o agente ligou: áudio", () => {
    expect(
      decidirFormatoDaResposta({ config: ligado, tipoDaMensagemQueDisparou: "audio", jobKind: "inbound_turn", preview: false }),
    ).toEqual({ formato: "audio", voz: "cedar", instrucoes: "Calma." });
  });

  it("cliente escreveu: texto, sem motivo (nada a registrar)", () => {
    expect(
      decidirFormatoDaResposta({ config: ligado, tipoDaMensagemQueDisparou: "text", jobKind: "inbound_turn", preview: false }),
    ).toEqual({ formato: "texto", motivo: null });
  });

  it("interruptor desligado (o padrão): texto, mesmo com áudio", () => {
    expect(
      decidirFormatoDaResposta({
        config: { enabled: false, voice: "cedar", instructions: null },
        tipoDaMensagemQueDisparou: "audio",
        jobKind: "inbound_turn",
        preview: false,
      }),
    ).toEqual({ formato: "texto", motivo: null });
    expect(
      decidirFormatoDaResposta({ config: null, tipoDaMensagemQueDisparou: "audio", jobKind: "inbound_turn", preview: false }),
    ).toEqual({ formato: "texto", motivo: null });
  });

  it("follow-up, resposta a caso e prévia nunca viram áudio", () => {
    for (const jobKind of ["followup_turn", "case_reply_turn", null]) {
      expect(
        decidirFormatoDaResposta({ config: ligado, tipoDaMensagemQueDisparou: "audio", jobKind, preview: false }).formato,
      ).toBe("texto");
    }
    expect(
      decidirFormatoDaResposta({ config: ligado, tipoDaMensagemQueDisparou: "audio", jobKind: "inbound_turn", preview: true }).formato,
    ).toBe("texto");
  });
});

describe("prepararRespostaEmAudio — chave e teto ANTES de qualquer envio", () => {
  it("sem chave OpenAI em degrau nenhum: texto com o motivo", async () => {
    const r = await prepararRespostaEmAudio({
      decisao: { formato: "audio", voz: "marin", instrucoes: null },
      chaveOpenai: async () => null,
      checarOrcamento: vi.fn(async () => "seguir" as const),
    });
    expect(r).toEqual({ pronta: null, motivo: "sem_chave_openai" });
  });

  it("teto de gasto mandou parar: não sintetiza", async () => {
    const r = await prepararRespostaEmAudio({
      decisao: { formato: "audio", voz: "marin", instrucoes: null },
      chaveOpenai: async () => ({ apiKey: "k", origemDaChave: "credencial_da_organizacao" }),
      checarOrcamento: async () => "barrado",
    });
    expect(r).toEqual({ pronta: null, motivo: "orcamento_esgotado" });
  });

  it("com chave e teto livre: pronta", async () => {
    const checar = vi.fn(async () => "seguir" as const);
    const r = await prepararRespostaEmAudio({
      decisao: { formato: "audio", voz: "marin", instrucoes: "x" },
      chaveOpenai: async () => ({ apiKey: "k", origemDaChave: "chave_da_instalacao" }),
      checarOrcamento: checar,
    });
    expect(r.pronta).toEqual({ apiKey: "k", origemDaChave: "chave_da_instalacao", voz: "marin", instrucoes: "x" });
    expect(checar).toHaveBeenCalledWith("chave_da_instalacao");
  });

  it("decisão de texto não lê chave nem orçamento", async () => {
    const chave = vi.fn();
    const r = await prepararRespostaEmAudio({
      decisao: { formato: "texto", motivo: null },
      chaveOpenai: chave,
      checarOrcamento: vi.fn(),
    });
    expect(r).toEqual({ pronta: null, motivo: null });
    expect(chave).not.toHaveBeenCalled();
  });
});

const pronta: VozPronta = { apiKey: "k", origemDaChave: "credencial_da_organizacao", voz: "marin", instrucoes: null };

describe("gerarNotaDeVoz — falha nunca é silêncio", () => {
  it("sintetiza o texto falável e guarda o Ogg", async () => {
    const sintetizar = vi.fn(async () => ({
      ok: true as const,
      audio: new Uint8Array([1, 2]),
      mime: "audio/ogg" as const,
      duracaoSeg: 4,
      latenciaMs: 10,
    }));
    const guardar = vi.fn(async () => ({ ok: true as const, storagePath: "org/conv/voz-1.ogg" }));
    const r = await gerarNotaDeVoz({ texto: "Sua audiência é em 15/03/2026.", pronta, sintetizar, guardar });
    expect(sintetizar).toHaveBeenCalledWith(
      expect.objectContaining({ texto: "Sua audiência é em quinze de março de dois mil e vinte e seis." }),
    );
    expect(r).toMatchObject({ ok: true, storagePath: "org/conv/voz-1.ogg", mime: "audio/ogg" });
    expect(r.chamada).toMatchObject({ ok: true, outputTokens: expect.any(Number) });
    expect(r.chamada?.costCents).toBeGreaterThan(0);
  });

  it("texto que não se fala (link) volta como motivo, sem chamar a OpenAI", async () => {
    const sintetizar = vi.fn();
    const r = await gerarNotaDeVoz({ texto: "Veja https://x.com", pronta, sintetizar, guardar: vi.fn() });
    expect(r).toEqual({ ok: false, motivo: "link_na_resposta", chamada: null });
    expect(sintetizar).not.toHaveBeenCalled();
  });

  it("erro da API: motivo + linha de custo com erro (zero tokens)", async () => {
    const r = await gerarNotaDeVoz({
      texto: "Oi, tudo bem?",
      pronta,
      sintetizar: async () => ({ ok: false, motivo: "erro_da_api", status: 401, detalhe: "bad key", latenciaMs: 5 }),
      guardar: vi.fn(),
    });
    expect(r).toMatchObject({ ok: false, motivo: "erro_da_api" });
    expect(r.chamada).toMatchObject({ ok: false, status: 401, inputTokens: 0, outputTokens: 0, costCents: 0 });
  });

  it("áudio gerado mas não guardado: motivo, e o custo da síntese continua contado", async () => {
    const r = await gerarNotaDeVoz({
      texto: "Oi, tudo bem?",
      pronta,
      sintetizar: async () => ({ ok: true, audio: new Uint8Array([1]), mime: "audio/ogg", duracaoSeg: 2, latenciaMs: 5 }),
      guardar: async () => ({ ok: false, detalhe: "bucket fora" }),
    });
    expect(r).toMatchObject({ ok: false, motivo: "falha_ao_guardar" });
    expect(r.chamada?.ok).toBe(true);
    expect(r.chamada?.costCents).toBeGreaterThan(0);
  });
});

describe("coletarApelidosDeProcesso", () => {
  it("acha pares número CNJ + apelido em qualquer profundidade do resultado da consulta", () => {
    const apelidos = new Map<string, string>();
    coletarApelidosDeProcesso(
      {
        ok: true,
        linhas: [
          { numero_cnj: "0001234-56.2024.8.26.0100", apelido: "Aposentadoria por idade", fase: "perícia" },
          { numero_cnj: "123", apelido: "inválido" },
        ],
        content: [{ type: "text", text: JSON.stringify({ rows: [{ numero_cnj: "0009999-11.2023.5.02.0001", apelido: "Ação do Bruno" }] }) }],
      },
      apelidos,
    );
    expect([...apelidos.entries()]).toEqual([
      ["0001234-56.2024.8.26.0100", "Aposentadoria por idade"],
      ["0009999-11.2023.5.02.0001", "Ação do Bruno"],
    ]);
  });
});
