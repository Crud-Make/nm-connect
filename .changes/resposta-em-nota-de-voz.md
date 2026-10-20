---
impacto: capacidade_nova
secao: adicionado
titulo: O agente pode responder nota de voz com nota de voz
---

Na tela do agente há um novo cartão, "Resposta em nota de voz", com o interruptor "Responder áudio com áudio" (desligado por padrão), a escolha da voz e uma instrução de tom opcional. Ligado e publicado, quando o cliente manda uma nota de voz a resposta sai como nota de voz no WhatsApp; quando ele escreve, a resposta continua em texto. A voz só fala o texto que já passou por todas as travas de envio (opt-out, LGPD, janela, promessa, vocabulário interno, conferência de fato), e nunca diz nada além dele. Se a voz não puder ser gerada (sem chave OpenAI, prazo de 20 s estourado, erro da OpenAI, resposta com link ou número de processo sem apelido, ou fala acima de cerca de um minuto), o mesmo texto vai como texto e o motivo fica registrado. A síntese usa o `gpt-4o-mini-tts` da OpenAI, com a chave OpenAI da organização ou a `OPENAI_API_KEY` da instalação, e cada nota entra em Uso de IA e no limite de gasto mensal. Na Inbox, a mensagem enviada aparece como áudio com o texto falado embaixo. A atualização aplica a migration 0677 (três colunas novas na versão do agente e o preço do modelo de voz); nada muda para quem não ligar o interruptor.
