/**
 * Processos — módulo de tabela da ADR-0002 (migration 0707).
 *
 * O molde cobre forma (D4) e efeito (provisionar cria exatamente as duas
 * tabelas, protegidas, e o núcleo fica intocado). `protecaoPropria` porque a
 * RLS aqui é POR OPERAÇÃO e por papel (leitura viewer+, escrita agent+,
 * apagar processo manager+; andamento em rascunho é do agent, o aprovado só
 * muda pelas RPCs), ligada dentro da própria função — a rotina 0325 só
 * enxerga tabela com RLS desligada, então a policy ampla não entra.
 */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";

moldeDeProvisionadora({
  modulo: "processos",
  tabelas: ["processos", "andamentos"],
  protecaoPropria: ["processos", "andamentos"],
});
