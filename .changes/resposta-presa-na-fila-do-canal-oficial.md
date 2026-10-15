---
impacto: nada_mudou
secao: corrigido
titulo: Resposta automática presa na fila do canal oficial vira falha visível, com aviso na Central
---

No canal oficial (e nos que espelham a Cloud API), a resposta da IA ou de uma automação que caía em fila — credencial do canal ausente, conexão fora do ar, envio interrompido no meio — ficava "na fila" para sempre: o reenvio automático só existe para a conexão por QR Code, e numa instalação só com o canal oficial ele nem liga. Agora o cron `recover-stuck-messages` marca essa mensagem como falha depois de 5 minutos (código `queued_timeout`, com o motivo da fila no texto), emite `message.failed` e abre um aviso "respostas não saíram da fila" na Central — o mesmo tratamento que a mensagem presa em "enviando" já recebia. Nada é reenviado sozinho. Fica de fora a mensagem que a plataforma já aceitou (com id do canal ou recibo confirmado), a que ainda tem um follow-up vivo para reprocessá-la, a mensagem digitada pelo atendente e toda a fila da conexão por QR Code, que segue com o reenvio de sempre. Nenhuma mudança de banco nem de configuração.
