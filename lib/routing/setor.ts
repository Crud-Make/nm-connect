/**
 * Setor no roteamento humano — regra PURA.
 *
 * Quando a conversa tem `setor_id` (gravado pelo Roteador de IA ao casar uma
 * intenção que aponta um setor), quem pode recebê-la é o conjunto que o canal
 * já permite ∩ os membros do setor. Duas decisões, escritas aqui porque o
 * código as executa:
 *
 *  1. **Setor sem membro nenhum NÃO restringe.** Um setor recém-criado e ainda
 *     vazio é configuração incompleta, não a ordem "ninguém atende" — prender
 *     a conversa nele deixaria o cliente sem resposta por um cadastro pela
 *     metade. Vale o comportamento de antes (só o canal decide).
 *  2. **Setor com membros e ninguém elegível agora ⇒ conjunto vazio.** A
 *     conversa fica na FILA (o worker reenfileira com backoff), e NÃO cai para
 *     outro setor: uma dúvida tributária atendida pelo previdenciário é pior do
 *     que uma espera visível. A fila mostra o setor (inbox), então a espera
 *     tem dono nomeado.
 *
 * O setor só ENCOLHE: nunca devolve alguém que a política do canal tirou.
 */
export function restringirAoSetor(
  allowed: Set<string> | null,
  membrosDoSetor: readonly string[] | null,
): Set<string> | null {
  if (membrosDoSetor === null || membrosDoSetor.length === 0) return allowed;
  if (allowed === null) return new Set(membrosDoSetor);
  return new Set(membrosDoSetor.filter((userId) => allowed.has(userId)));
}
