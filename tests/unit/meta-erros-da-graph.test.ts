/**
 * O mapa de códigos da Graph — um lugar só, para os dois transportes do dialeto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErroDeEnvioDoCanal } from "@/lib/channels/erro-de-envio";
import {
  classificarErroDaGraph,
  ehTempoEsgotado,
  erroDaRespostaDaGraph,
  GRAPH_TIMEOUT_ENVIO_MS,
  postarMensagemNaGraph,
} from "@/lib/channels/meta/erros-da-graph";
import { sendTemplate } from "@/lib/channels/meta/send-template";
import { explainSendResult } from "@/lib/channels/meta/send-template-outcome";
import { fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("classificarErroDaGraph", () => {
  it.each([
    [190, "meta_token_invalido", "credencial"],
    [130429, "meta_limite_de_envio", "temporaria"],
    [131056, "meta_limite_do_par", "temporaria"],
  ])("%i → %s / %s", (code, codigo, natureza) => {
    expect(classificarErroDaGraph(code)).toEqual({ codigo, natureza });
  });

  it("código desconhecido ou ausente cai no genérico de sempre (adapter.codes.sendFailed)", () => {
    expect(classificarErroDaGraph(131009)).toEqual({
      codigo: "meta_error",
      natureza: "permanente",
    });
    expect(classificarErroDaGraph(undefined)).toEqual({
      codigo: "meta_error",
      natureza: "permanente",
    });
  });

  it("o prefixo separa o transporte do parceiro na coluna", () => {
    expect(classificarErroDaGraph(190, "datafy").codigo).toBe("datafy_token_invalido");
    expect(classificarErroDaGraph(1, "datafy").codigo).toBe("datafy_error");
  });

  it("todo código classificado tem frase de tela — nos dois prefixos, e o timeout também", () => {
    for (const prefixo of ["meta", "datafy"]) {
      for (const code of [190, 130429, 131056]) {
        expect(
          fraseDaFalhaDeCanal(classificarErroDaGraph(code, prefixo).codigo),
          `${prefixo} ${code}`,
        ).not.toBeNull();
      }
      expect(fraseDaFalhaDeCanal(`${prefixo}_timeout`)).toMatch(/pode ter saído/i);
    }
  });
});

describe("erroDaRespostaDaGraph", () => {
  it("preserva o formato `<prefixo>_<code>: detalhe` que o operador já lia", () => {
    const e = erroDaRespostaDaGraph({ code: 190, status: 401, detalhe: "Session has expired" });
    expect(e).toBeInstanceOf(ErroDeEnvioDoCanal);
    expect(e.message).toBe("meta_190: Session has expired");
    expect(e.codigo).toBe("meta_token_invalido");
  });

  it("sem code no corpo usa o status HTTP na mensagem", () => {
    expect(erroDaRespostaDaGraph({ code: null, status: 502, detalhe: "http_502" }).message).toBe(
      "meta_502: http_502",
    );
  });
});

describe("tempo esgotado", () => {
  it("reconhece os dois nomes de aborto e mais nenhum", () => {
    expect(ehTempoEsgotado({ name: "TimeoutError" })).toBe(true);
    expect(ehTempoEsgotado({ name: "AbortError" })).toBe(true);
    expect(ehTempoEsgotado(new TypeError("fetch failed"))).toBe(false);
    expect(ehTempoEsgotado(null)).toBe(false);
  });

  it("postarMensagemNaGraph pede o teto de envio e converte o aborto em incerta", async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const pedidos: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      pedidos.push(ms);
      return original(10);
    });
    const spy = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_r, rej) =>
          init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)),
        ),
    );
    vi.stubGlobal("fetch", spy);

    const erro = await postarMensagemNaGraph({
      url: "https://x/messages",
      token: "t",
      corpo: {},
      prefixo: "datafy",
    }).catch((e: unknown) => e);

    expect(pedidos).toEqual([GRAPH_TIMEOUT_ENVIO_MS]);
    expect(erro).toMatchObject({ codigo: "datafy_timeout", natureza: "incerta" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("modelo (template) — mesmo teto, desfecho próprio", () => {
  it("Graph pendurada no envio de modelo vira reason 'timeout', e o modelo é mandado PARAR", async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const pedidos: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      pedidos.push(ms);
      return original(10);
    });
    const spy = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_r, rej) =>
          init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)),
        ),
    );
    vi.stubGlobal("fetch", spy);

    const r = await sendTemplate({
      phoneNumberId: "pn",
      token: "t",
      graphVersion: "v22.0",
      to: "5531",
      binding: { name: "oi", language: "pt_BR", contractHash: "h", values: {} },
      current: {
        name: "oi",
        language: "pt_BR",
        contractHash: "h",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Olá" }],
      },
    });

    expect(r).toEqual({ sent: false, reason: "timeout" });
    expect(pedidos).toContain(GRAPH_TIMEOUT_ENVIO_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    const o = explainSendResult(r);
    expect(o.retriable).toBe(false);
    expect(o.message).toMatch(/Encerre o turno/);
  });
});
