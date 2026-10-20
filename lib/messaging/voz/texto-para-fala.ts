/**
 * O TEXTO APROVADO, PRONTO PARA SER FALADO (resposta em nota de voz).
 *
 * Quem chega aqui é o corpo que JÁ passou por toda a cadeia `before_send`
 * (`lib/agent-engine/guardrails/before-send.ts`). Esta função não acrescenta
 * nada ao que foi aprovado: só troca a FORMA (o que se lê pelo que se ouve) e
 * tira o que não se fala — markdown, emoji, marcador de lista. O áudio nunca
 * diz algo que o texto aprovado não diga.
 *
 * Quando a forma falada perderia informação que o cliente precisa ter ESCRITA
 * (um link, um número de processo de que não sabemos o apelido) ou passaria de
 * ~1 minuto de fala, a resposta é `ok: false` com o motivo, e quem chama manda
 * o texto aprovado como texto. Nunca silêncio, nunca áudio pela metade.
 *
 * Pura e sem I/O: testada em `texto-para-fala.test.ts`.
 */

/**
 * ~1 minuto de fala. Medida de bolso: português falado em ritmo de atendimento
 * fica perto de 150 palavras (≈ 900 caracteres) por minuto. Acima disso a nota
 * de voz vira um monólogo que o cliente não consegue reouvir por partes — e o
 * texto é melhor. O teto da API (4096 caracteres) fica bem acima deste.
 */
export const LIMITE_DE_CARACTERES_FALADOS = 900;

export type MotivoDeNaoFalar =
  "vazio" | "link_na_resposta" | "processo_sem_apelido" | "longo_demais";

export type TextoFalavel = { ok: true; texto: string } | { ok: false; motivo: MotivoDeNaoFalar };

export interface OpcoesDaFala {
  /**
   * Número CNJ → apelido do processo, colhido do resultado da consulta ao banco
   * de processos no próprio turno. A chave é o número no formato CNJ
   * (`NNNNNNN-DD.AAAA.J.TR.OOOO`).
   */
  apelidos?: ReadonlyMap<string, string>;
}

// ─── números por extenso ────────────────────────────────────────────────────

type Genero = "masculino" | "feminino";

const UNIDADES = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const DEZ_A_DEZENOVE = [
  "dez",
  "onze",
  "doze",
  "treze",
  "catorze",
  "quinze",
  "dezesseis",
  "dezessete",
  "dezoito",
  "dezenove",
];
const DEZENAS = [
  "",
  "",
  "vinte",
  "trinta",
  "quarenta",
  "cinquenta",
  "sessenta",
  "setenta",
  "oitenta",
  "noventa",
];
const CENTENAS = [
  "",
  "cento",
  "duzentos",
  "trezentos",
  "quatrocentos",
  "quinhentos",
  "seiscentos",
  "setecentos",
  "oitocentos",
  "novecentos",
];

function unidade(n: number, genero: Genero): string {
  if (genero === "feminino") {
    if (n === 1) return "uma";
    if (n === 2) return "duas";
  }
  return UNIDADES[n]!;
}

/** 1..999 */
function ateMil(n: number, genero: Genero): string {
  if (n === 100) return "cem";
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (c > 0) {
    let centena = CENTENAS[c]!;
    if (genero === "feminino" && c >= 2) centena = centena.replace(/os$/, "as");
    partes.push(centena);
  }
  if (resto > 0) {
    if (resto < 10) partes.push(unidade(resto, genero));
    else if (resto < 20) partes.push(DEZ_A_DEZENOVE[resto - 10]!);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u === 0 ? DEZENAS[d]! : `${DEZENAS[d]} e ${unidade(u, genero)}`);
    }
  }
  return partes.join(" e ");
}

/**
 * Inteiro não negativo por extenso, em português do Brasil. Até a casa dos
 * bilhões, que é muito além de qualquer valor que um atendimento fale.
 */
export function numeroPorExtenso(n: number, genero: Genero = "masculino"): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  n = Math.floor(n);
  if (n === 0) return "zero";
  const grupos: { valor: number; nome: (v: number) => string }[] = [
    { valor: Math.floor(n / 1_000_000_000) % 1000, nome: (v) => (v === 1 ? "bilhão" : "bilhões") },
    { valor: Math.floor(n / 1_000_000) % 1000, nome: (v) => (v === 1 ? "milhão" : "milhões") },
    { valor: Math.floor(n / 1000) % 1000, nome: () => "mil" },
    { valor: n % 1000, nome: () => "" },
  ];
  const ditos = grupos.map((g, i) => ({ ...g, i })).filter((g) => g.valor > 0);
  const partes: string[] = [];
  ditos.forEach((g, idx) => {
    // "mil", nunca "um mil"; milhão e bilhão são masculinos ("dois milhões").
    const generoDoGrupo: Genero = g.i === 3 || g.i === 2 ? genero : "masculino";
    const numero = g.i === 2 && g.valor === 1 ? "" : ateMil(g.valor, generoDoGrupo);
    const nome = g.nome(g.valor);
    const texto = [numero, nome].filter(Boolean).join(" ");
    if (idx === 0) {
      partes.push(texto);
      return;
    }
    // O "e" entre grupos só aparece antes do ÚLTIMO grupo dito quando ele é
    // "redondo" (abaixo de 100 ou centena exata): "mil e quinhentos", mas
    // "mil quinhentos e cinquenta".
    const ultimo = idx === ditos.length - 1;
    const redondo = g.valor < 100 || g.valor % 100 === 0;
    partes.push(ultimo && redondo ? `e ${texto}` : texto);
  });
  return partes.join(" ");
}

// ─── as trocas de forma ─────────────────────────────────────────────────────

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

const CNJ = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const URL_OU_WWW = /\b(?:https?:\/\/|www\.)\S+/i;

function dia(n: number): string {
  return n === 1 ? "primeiro" : numeroPorExtenso(n);
}

function reais(inteiro: number, centavos: number): string {
  const partes: string[] = [];
  if (inteiro > 0) partes.push(`${numeroPorExtenso(inteiro)} ${inteiro === 1 ? "real" : "reais"}`);
  if (centavos > 0)
    partes.push(`${numeroPorExtenso(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  if (partes.length === 0) return "zero real";
  return partes.join(" e ");
}

function hora(h: number, m: number): string {
  if (m === 0) return `${numeroPorExtenso(h, "feminino")} ${h === 1 ? "hora" : "horas"}`;
  return `${numeroPorExtenso(h, "feminino")} e ${numeroPorExtenso(m)}`;
}

function semMarkdown(t: string): string {
  return (
    t
      // [texto](url) → texto (o link em si já foi recusado antes)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_~]([^*_~\n]+)[*_~](?=[\s.,;:!?)]|$)/g, "$1$2")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/[*_~`]/g, "")
  );
}

function semEmoji(t: string): string {
  return t
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[‍︎️⃣]/g, "");
}

/** Cada item de lista vira uma frase; quebras de linha viram espaço. */
function semLista(t: string): string {
  const linhas = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const frases = linhas.map((linha) => {
    const item = linha.match(/^(?:[-*•–]|\d{1,2}[.)])\s+(.*)$/);
    if (!item) return { texto: linha, item: false };
    const corpo = item[1]!.trim();
    const comPonto = /[.!?;:]$/.test(corpo) ? corpo : `${corpo}.`;
    return { texto: comPonto.charAt(0).toUpperCase() + comPonto.slice(1), item: true };
  });
  return frases.map((f) => f.texto).join(" ");
}

function processosPorApelido(t: string, apelidos: ReadonlyMap<string, string>): string | null {
  let semNumero = t;
  // "Apelido (processo nº 0001234-…)" → "Apelido": o apelido já foi dito.
  semNumero = semNumero.replace(
    /\s*\(\s*(?:o\s+)?(?:processo\s*)?(?:n[º°o.]*\s*)?(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})\s*\)/gi,
    (todo, cnj: string, offset: number) => {
      const apelido = apelidos.get(cnj);
      if (apelido && semNumero.slice(0, offset).toLowerCase().includes(apelido.toLowerCase()))
        return "";
      return todo;
    },
  );
  let faltou = false;
  semNumero = semNumero.replace(
    /(?:n[º°o.]*\s*)?(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/gi,
    (_todo, cnj: string) => {
      const apelido = apelidos.get(cnj);
      if (!apelido) {
        faltou = true;
        return cnj;
      }
      return apelido;
    },
  );
  return faltou ? null : semNumero;
}

function formasFaladas(t: string): string {
  return (
    t
      // R$ 1.500,00 / R$0,90 / R$ 25
      .replace(/R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/g, (_m, int: string, cent?: string) =>
        reais(Number(int.replace(/\./g, "")), cent ? Number(cent) : 0),
      )
      // 15/03/2026 e 01/12
      .replace(
        /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g,
        (todo, d: string, m: string, a?: string) => {
          const nd = Number(d);
          const nm = Number(m);
          if (nd < 1 || nd > 31 || nm < 1 || nm > 12) return todo;
          const base = `${dia(nd)} de ${MESES[nm - 1]}`;
          return a ? `${base} de ${numeroPorExtenso(Number(a))}` : base;
        },
      )
      // 14:30, 18:00, 14h30, 9h
      .replace(
        /\b(\d{1,2})(?::(\d{2})|h(\d{2})?)(?![\d%])/g,
        (todo, h: string, m1?: string, m2?: string) => {
          const nh = Number(h);
          const nm = Number(m1 ?? m2 ?? 0);
          if (nh > 23 || nm > 59) return todo;
          return hora(nh, nm);
        },
      )
      // 10% / 2,5%
      .replace(/\b(\d+)(?:,(\d+))?\s?%/g, (_m, int: string, dec?: string) =>
        dec
          ? `${numeroPorExtenso(Number(int))} vírgula ${numeroPorExtenso(Number(dec))} por cento`
          : `${numeroPorExtenso(Number(int))} por cento`,
      )
  );
}

function arrumarEspacos(t: string): string {
  return t
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\1+/g, "$1")
    .trim();
}

/**
 * O texto aprovado → o texto que vai à síntese, ou o motivo de mandar texto.
 */
export function textoParaFala(texto: string, opcoes: OpcoesDaFala = {}): TextoFalavel {
  if (URL_OU_WWW.test(texto)) return { ok: false, motivo: "link_na_resposta" };

  let t = texto;
  if (CNJ.test(t)) {
    CNJ.lastIndex = 0;
    const trocado = processosPorApelido(t, opcoes.apelidos ?? new Map());
    if (trocado === null) return { ok: false, motivo: "processo_sem_apelido" };
    t = trocado;
  }
  CNJ.lastIndex = 0;

  t = semEmoji(t);
  t = semMarkdown(t);
  t = semLista(t);
  t = formasFaladas(t);
  t = arrumarEspacos(t);

  if (!/[\p{L}\p{N}]/u.test(t)) return { ok: false, motivo: "vazio" };
  if (t.length > LIMITE_DE_CARACTERES_FALADOS) return { ok: false, motivo: "longo_demais" };
  return { ok: true, texto: t };
}
