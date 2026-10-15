/**
 * O setor que a intenção do roteador grava na conversa (migration 0675).
 *
 * O Roteador de IA classifica a intenção; quando o membro casado aponta um
 * setor, a conversa passa a ser daquele setor e o roteamento humano
 * (`lib/routing/eligibles.ts` + `lib/routing/setor.ts`) só a entrega a quem é
 * dele.
 *
 * ─── Quando grava, e por que sobrescreve ─────────────────────────────────────
 *
 * Grava só em decisão NOVA e CONFIANTE: `classified` (primeira classificação
 * acima de `minConfidence`) e `reclassified` (o cliente mudou de assunto e o
 * classificador, de novo acima do limiar, escolheu outra intenção). E aí
 * SOBRESCREVE o setor anterior: quem pergunta de imposto e depois de
 * aposentadoria está agora no Previdenciário, e deixar o setor antigo mandaria
 * a conversa para a fila errada.
 *
 * Não grava em `sticky` (nenhuma decisão nova — o assunto é o mesmo, e o setor
 * já foi gravado quando ele foi decidido), nem em fallback/no_match/falha do
 * classificador (não houve casamento com confiança), nem em preview/campanha.
 * E nunca APAGA: intenção sem setor não tira o setor de uma conversa.
 *
 * Transferência manual de setor pela tela está fora desta entrega.
 */
import type pg from 'pg';

const DECISOES_CONFIANTES = new Set(['classified', 'reclassified']);

export function setorParaGravar(routed: { outcome: string; setorId?: string | null }): string | null {
  if (!DECISOES_CONFIANTES.has(routed.outcome)) return null;
  return routed.setorId ?? null;
}

/**
 * Grava o setor na conversa, filtrando a organização (o pool do motor não tem
 * RLS). `is distinct from` evita escrita (e o evento de Realtime que ela gera)
 * quando o setor já é o mesmo. Devolve se mudou.
 */
export async function gravaSetorDaConversa(
  db: Pick<pg.Pool, 'query'>,
  organizationId: string,
  conversationId: string,
  setorId: string,
): Promise<boolean> {
  const r = await db.query(
    `update conversations
        set setor_id = $3
      where organization_id = $1 and id = $2
        and setor_id is distinct from $3`,
    [organizationId, conversationId, setorId],
  );
  return (r.rowCount ?? 0) > 0;
}
