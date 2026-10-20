import { describe, expect, it, vi } from "vitest";

import {
  custoDaSintese,
  duracaoDoOggOpus,
  MODELO_DE_FALA,
  sintetizarFala,
  TOKENS_DE_AUDIO_POR_SEGUNDO,
  VOZ_PADRAO,
} from "./sintese-de-fala";

/**
 * Um Ogg/Opus mínimo, com o que este módulo lê: a página do cabeçalho
 * `OpusHead` (pre-skip) e uma última página com a granule position.
 */
function oggOpus(segundos: number, preSkip = 312): Uint8Array {
  const pagina = (granule: bigint, corpo: Uint8Array): Uint8Array => {
    const cab = new Uint8Array(27 + 1);
    cab.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    new DataView(cab.buffer).setBigInt64(6, granule, true);
    cab[26] = 1; // um segmento
    cab[27] = corpo.length;
    const out = new Uint8Array(cab.length + corpo.length);
    out.set(cab);
    out.set(corpo, cab.length);
    return out;
  };
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1; // versão
  head[9] = 1; // canais
  new DataView(head.buffer).setUint16(10, preSkip, true);
  const primeira = pagina(0n, head);
  const ultima = pagina(BigInt(Math.round(segundos * 48_000) + preSkip), new Uint8Array([1, 2, 3]));
  const out = new Uint8Array(primeira.length + ultima.length);
  out.set(primeira);
  out.set(ultima, primeira.length);
  return out;
}

function resposta(corpo: BodyInit | null, status = 200): Response {
  return new Response(corpo, { status, headers: { "content-type": "audio/ogg" } });
}

describe("duracaoDoOggOpus", () => {
  it("lê a duração pela granule da última página, descontado o pre-skip", () => {
    expect(duracaoDoOggOpus(oggOpus(12.5))).toBeCloseTo(12.5, 2);
  });

  it("devolve null para o que não é Ogg/Opus", () => {
    expect(duracaoDoOggOpus(new TextEncoder().encode("ID3 mp3 qualquer"))).toBeNull();
  });
});

describe("sintetizarFala — o pedido à OpenAI", () => {
  it("manda modelo, voz, instrução e formato opus, com a chave no cabeçalho", async () => {
    const fetchDuble = vi.fn(async () => resposta(oggOpus(3)));
    const r = await sintetizarFala({
      apiKey: "sk-teste",
      texto: "Olá, tudo bem?",
      voz: "cedar",
      instrucoes: "Fale com calma, sotaque paulista.",
      fetch: fetchDuble,
    });
    expect(r.ok).toBe(true);
    const [url, init] = fetchDuble.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-teste");
    expect(JSON.parse(init.body as string)).toEqual({
      model: MODELO_DE_FALA,
      input: "Olá, tudo bem?",
      voice: "cedar",
      instructions: "Fale com calma, sotaque paulista.",
      response_format: "opus",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (r.ok) {
      expect(r.mime).toBe("audio/ogg");
      expect(r.duracaoSeg).toBeCloseTo(3, 2);
    }
  });

  it("voz desconhecida cai na padrão; instrução vazia não vai", async () => {
    const fetchDuble = vi.fn(async () => resposta(oggOpus(1)));
    await sintetizarFala({ apiKey: "k", texto: "Oi", voz: "robozinho", instrucoes: "  ", fetch: fetchDuble });
    const corpo = JSON.parse((fetchDuble.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(corpo.voice).toBe(VOZ_PADRAO);
    expect(corpo).not.toHaveProperty("instructions");
  });

  it("erro da API vira motivo, com o status — nunca exceção", async () => {
    const r = await sintetizarFala({
      apiKey: "k",
      texto: "Oi",
      voz: VOZ_PADRAO,
      fetch: async () => new Response('{"error":{"message":"quota"}}', { status: 429 }),
    });
    expect(r).toMatchObject({ ok: false, motivo: "erro_da_api", status: 429 });
  });

  it("estouro do prazo vira `prazo_esgotado`", async () => {
    const r = await sintetizarFala({
      apiKey: "k",
      texto: "Oi",
      voz: VOZ_PADRAO,
      prazoMs: 5,
      fetch: (_url, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
        }),
    });
    expect(r).toMatchObject({ ok: false, motivo: "prazo_esgotado" });
  });

  it("falha de rede vira `rede`", async () => {
    const r = await sintetizarFala({
      apiKey: "k",
      texto: "Oi",
      voz: VOZ_PADRAO,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(r).toMatchObject({ ok: false, motivo: "rede" });
  });

  it("resposta que não é Ogg/Opus é recusada: a Meta só faz bolha de voz com ogg/opus", async () => {
    const r = await sintetizarFala({
      apiKey: "k",
      texto: "Oi",
      voz: VOZ_PADRAO,
      fetch: async () => resposta(new TextEncoder().encode("ID3 isto é mp3")),
    });
    expect(r).toMatchObject({ ok: false, motivo: "formato_invalido" });
  });
});

describe("custoDaSintese — o que entra no teto de gasto", () => {
  it("texto de entrada a US$ 0,60/MTok + áudio de saída a US$ 12/MTok", () => {
    // 400 caracteres ≈ 100 tokens de texto; 30 s de áudio ≈ 625 tokens.
    const c = custoDaSintese({ caracteres: 400, duracaoSeg: 30 });
    expect(c.inputTokens).toBe(100);
    expect(c.outputTokens).toBe(Math.round(30 * TOKENS_DE_AUDIO_POR_SEGUNDO));
    const esperado = ((100 * 0.6 + c.outputTokens * 12) / 1_000_000) * 100;
    expect(c.costCents).toBeCloseTo(esperado, 8);
    // Ordem de grandeza: meio minuto de fala custa perto de 0,75 centavo de dólar.
    expect(c.costCents).toBeGreaterThan(0.7);
    expect(c.costCents).toBeLessThan(0.8);
  });

  it("sem duração lida, estima pelo tamanho do texto (nunca custo zero)", () => {
    const c = custoDaSintese({ caracteres: 300, duracaoSeg: null });
    expect(c.outputTokens).toBeGreaterThan(0);
    expect(c.costCents).toBeGreaterThan(0);
  });
});
