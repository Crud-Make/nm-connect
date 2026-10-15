---
impacto: nada_mudou
secao: corrigido
titulo: No canal oficial, a mensagem do cliente que o banco não conseguiu gravar é tentada de novo, e a reentrega acorda o agente que não tinha acordado
---

Quando o banco falhava no instante em que uma mensagem chegava pelo canal oficial da Meta, a mensagem se perdia: o servidor respondia à Meta que tinha recebido (para ela não reenviar sem parar) e não guardava a mensagem em lugar nenhum. Agora todo aviso da Meta fica guardado no arquivo de webhooks, como já acontecia no WhatsApp por QR, e o que falhou é tentado de novo a cada minuto. Se continuar falhando por cerca de 20 minutos, aparece um aviso na Central.

Também foi corrigido o caso em que a mensagem chegava a ser gravada mas o servidor parava antes de acordar o agente: quando a Meta reenviava a mesma mensagem, ela era reconhecida como repetida e o agente nunca respondia. Agora a reentrega confere se o agente foi acordado para aquela mensagem e, se não foi, acorda uma vez só.

Você não precisa fazer nada.
