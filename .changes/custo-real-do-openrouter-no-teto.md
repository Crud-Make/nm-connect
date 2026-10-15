---
impacto: nada_mudou
secao: corrigido
titulo: Com a OpenRouter, o gasto de IA passa a ser medido e o teto mensal volta a disparar
---

Em instalação que usa a OpenRouter, toda chamada de modelo fora da tabela de preços do motor (ids como `z-ai/glm-4.7`) gravava custo desconhecido. A régua do orçamento soma desconhecido como zero, então a tela Uso e orçamento mostrava US$ 0,00 e o teto mensal nunca disparava, com o dinheiro saindo. Agora o motor grava o custo que a própria OpenRouter informa em cada resposta (`usage.cost`, que inclui a parte do provedor de origem quando a chave é BYOK). Sem ele, usa o preço do catálogo de modelos que o produto já sincroniza. Anthropic, OpenAI e Gemini seguem cobrados pela tabela de sempre. O aviso de "gasto incompleto" some sozinho conforme entram chamadas novas e continua aceso para modelo sem preço em lugar nenhum. Nenhuma mudança de banco. O teto continua desligado por padrão: quem quer a parada liga em IA › Uso e orçamento (`/app/ai/usage`, papel admin), primeiro em "Me avisar" e depois em "Parar a IA" (com carência de 72 horas).
