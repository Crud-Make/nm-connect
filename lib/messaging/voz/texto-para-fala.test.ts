import { describe, expect, it } from "vitest";

import {
  LIMITE_DE_CARACTERES_FALADOS,
  numeroPorExtenso,
  textoParaFala,
} from "./texto-para-fala";

function falado(texto: string, apelidos?: ReadonlyMap<string, string>): string {
  const r = textoParaFala(texto, apelidos ? { apelidos } : {});
  if (!r.ok) throw new Error(`esperava texto falável, veio ${r.motivo}`);
  return r.texto;
}

describe("numeroPorExtenso", () => {
  it.each([
    [0, "zero"],
    [1, "um"],
    [15, "quinze"],
    [21, "vinte e um"],
    [100, "cem"],
    [101, "cento e um"],
    [345, "trezentos e quarenta e cinco"],
    [1000, "mil"],
    [1500, "mil e quinhentos"],
    [1550, "mil quinhentos e cinquenta"],
    [2026, "dois mil e vinte e seis"],
    [21000, "vinte e um mil"],
    [1_000_000, "um milhão"],
    [2_500_000, "dois milhões e quinhentos mil"],
  ])("%i → %s", (n, esperado) => {
    expect(numeroPorExtenso(n)).toBe(esperado);
  });

  it("concorda no feminino quando pedido (horas)", () => {
    expect(numeroPorExtenso(1, "feminino")).toBe("uma");
    expect(numeroPorExtenso(2, "feminino")).toBe("duas");
    expect(numeroPorExtenso(22, "feminino")).toBe("vinte e duas");
    expect(numeroPorExtenso(200, "feminino")).toBe("duzentas");
  });
});

describe("textoParaFala — o que o cliente ouve", () => {
  it("tira markdown, asteriscos e crases", () => {
    expect(falado("Olá! *Tudo certo* com o **seu caso**. Use `isto`.")).toBe(
      "Olá! Tudo certo com o seu caso. Use isto.",
    );
  });

  it("tira emojis, inclusive os compostos", () => {
    expect(falado("Pode deixar 👍 já vejo isso 👨‍⚖️!")).toBe("Pode deixar já vejo isso!");
  });

  it("transforma lista em frases", () => {
    expect(falado("Precisamos de:\n- RG\n- comprovante de residência\n1. CPF")).toBe(
      "Precisamos de: RG. Comprovante de residência. CPF.",
    );
  });

  it("lê data como uma pessoa fala", () => {
    expect(falado("A audiência é em 15/03/2026.")).toBe(
      "A audiência é em quinze de março de dois mil e vinte e seis.",
    );
    expect(falado("Prazo até 01/12.")).toBe("Prazo até primeiro de dezembro.");
  });

  it("lê valor em reais por extenso", () => {
    expect(falado("Os honorários são R$ 1.500,00.")).toBe("Os honorários são mil e quinhentos reais.");
    expect(falado("Custa R$ 1,50.")).toBe("Custa um real e cinquenta centavos.");
    expect(falado("Taxa de R$0,90")).toBe("Taxa de noventa centavos");
  });

  it("lê porcentagem e hora", () => {
    expect(falado("Desconto de 10% às 14h30.")).toBe("Desconto de dez por cento às catorze e trinta.");
    expect(falado("Abrimos às 9h e fechamos às 18:00.")).toBe(
      "Abrimos às nove horas e fechamos às dezoito horas.",
    );
    expect(falado("Volto em 1h.")).toBe("Volto em uma hora.");
  });

  it("número de processo vira o apelido, nunca dígito a dígito", () => {
    const apelidos = new Map([["0001234-56.2024.8.26.0100", "Aposentadoria por idade"]]);
    expect(falado("O processo 0001234-56.2024.8.26.0100 está na fase de perícia.", apelidos)).toBe(
      "O processo Aposentadoria por idade está na fase de perícia.",
    );
    // O modelo costuma pôr o número entre parênteses depois do apelido: some o número.
    expect(
      falado("Aposentadoria por idade (processo nº 0001234-56.2024.8.26.0100) andou.", apelidos),
    ).toBe("Aposentadoria por idade andou.");
  });

  it("processo sem apelido conhecido não vira áudio", () => {
    expect(textoParaFala("Seu processo 0001234-56.2024.8.26.0100 andou.")).toEqual({
      ok: false,
      motivo: "processo_sem_apelido",
    });
  });

  it("link não vira áudio: o cliente precisa dele escrito", () => {
    expect(textoParaFala("Acesse https://exemplo.com.br/agenda para marcar.")).toEqual({
      ok: false,
      motivo: "link_na_resposta",
    });
  });

  it("texto longo demais (mais de ~1 min de fala) não vira áudio", () => {
    const longo = "Esta frase tem umas palavras. ".repeat(40);
    expect(longo.length).toBeGreaterThan(LIMITE_DE_CARACTERES_FALADOS);
    expect(textoParaFala(longo)).toEqual({ ok: false, motivo: "longo_demais" });
  });

  it("texto que some inteiro na limpeza não vira áudio", () => {
    expect(textoParaFala("👍👍")).toEqual({ ok: false, motivo: "vazio" });
  });
});
