---
impacto: capacidade_nova
secao: adicionado
titulo: Setores do atendimento — o roteador de IA leva a conversa para um setor e só quem é do setor a recebe
---

Equipe ganhou a aba **Setores** (`/app/team?aba=setores`): cada setor tem um nome e os atendentes que respondem por aquela área. No editor do roteador de IA, cada intenção pode apontar um setor; quando ela casa com confiança, a conversa passa a ser daquele setor (casar de novo com outra intenção que aponta outro setor troca o setor). Na passagem para humano — pelo rodízio automático ou pela ferramenta de handoff — só membros do setor recebem a conversa; se ninguém do setor estiver de plantão, ela espera na fila em vez de cair para outro setor, e a Inbox mostra o setor na lista e no cabeçalho, com filtro "Setor". Setor ainda sem membros não restringe nada, e conversa sem setor segue a regra de antes. Criar, editar e excluir setor é de gerente para cima; excluir um setor deixa as conversas e as intenções que apontavam para ele sem setor, sem apagar nada. Mudança de banco aditiva (migration 0675), aplicada pelo `update.sh` sem ação do operador.
