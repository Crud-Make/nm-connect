---
impacto: nada_mudou
secao: corrigido
titulo: Envio pelo WhatsApp Oficial não trava mais esperando a Meta, e os erros principais dizem o que fazer
---

O envio pela Graph API (canal oficial e parceiro Graph-compatível) não tinha teto de espera: uma Meta que não respondia segurava o turno do agente e a tela de quem enviou para sempre. Agora o envio desiste em 25 s (a gestão de modelos, em 30 s) e a mensagem termina `failed` com o código `meta_timeout` e a frase "pode ter saído — confira a conversa antes de reenviar". Ela **não é reenviada automaticamente**, nem pelo agente: abortar a espera não prova que a Meta não entregou, e envio em dobro é pior que não-envio. Os erros da Meta ganharam código próprio no lugar do genérico `meta_error`: token vencido ou revogado (190) vira `meta_token_invalido`, marca a conexão como `FAILED` e abre um aviso crítico na Central dizendo para gravar um token novo em Conexões; limite de envio (130429) e limite por contato (131056) viram `meta_limite_de_envio` / `meta_limite_do_par`, com a frase "não saiu, tente em alguns minutos". Nenhuma mudança de banco nem de configuração.
