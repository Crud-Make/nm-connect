/**
 * AS SEÇÕES DA FICHA DO CONTATO — a lista que o menu lateral de `/app/contacts/[id]` desenha.
 *
 * Uma lista só, declarativa: seção nova (por exemplo, a de um módulo instalado) é uma linha aqui
 * e um bloco de conteúdo na ficha; o menu, a gaveta do celular e a leitura de `?secao=` não mudam.
 *
 * A condição recebe o que a TELA já decidiu: `processosAtivo` vem do servidor (`page.tsx`, módulo
 * de tabela pela ADR-0002) e `isAdmin` é o mesmo gate que já escondia a aba LGPD.
 *
 * O `rotulo` é a chave do `t()`. Por ser dado e não JSX, a varredura de espanhol não o enxerga;
 * quem cobra a tradução é `tests/unit/ficha-secoes-menu-lateral.test.tsx`.
 */

export interface CondicoesDaFicha {
  processosAtivo: boolean;
  isAdmin: boolean;
}

export interface SecaoDaFicha {
  id: string;
  rotulo: string;
  visivel?: (c: CondicoesDaFicha) => boolean;
}

export const SECOES_DA_FICHA: readonly SecaoDaFicha[] = [
  { id: "visao-geral", rotulo: "Visão geral" },
  { id: "processos", rotulo: "Processos", visivel: (c) => c.processosAtivo },
  { id: "timeline", rotulo: "Timeline" },
  { id: "lgpd", rotulo: "LGPD", visivel: (c) => c.isAdmin },
];

export function secoesDaFicha(condicoes: CondicoesDaFicha): SecaoDaFicha[] {
  return SECOES_DA_FICHA.filter((s) => s.visivel?.(condicoes) ?? true);
}

/** `?secao=` de seção escondida ou desconhecida cai na primeira — link velho nunca abre tela vazia. */
export function secaoAtiva(param: string | null, secoes: readonly SecaoDaFicha[]): string {
  return secoes.find((s) => s.id === param)?.id ?? secoes[0]!.id;
}
