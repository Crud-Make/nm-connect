---
impacto: nada_mudou
secao: corrigido
titulo: No canal oficial, mensagem que falhou não volta a aparecer como enviada, e os horários de entrega e leitura são os da Meta
---

A Meta reenvia os avisos de status e nem sempre na ordem certa. Quando um aviso de "entregue" chegava atrasado, depois do de "falhou", a mensagem voltava a aparecer como enviada e o motivo da falha ficava escondido. Agora, depois de marcada como falha, a mensagem continua como falha.

Os horários de entrega e de leitura passam a ser a hora informada pela Meta, e não a hora em que o aviso chegou ao servidor. Um aviso repetido não muda mais esses horários.

Também foi corrigido um caso no recebimento do webhook da Meta: uma assinatura com o tamanho certo, mas com caracteres inválidos, derrubava a requisição com erro 500. Agora ela é recusada com 401, como qualquer assinatura inválida.

Você não precisa fazer nada.
