---
impacto: capacidade_nova
secao: corrigido
titulo: O WhatsApp oficial recebe e responde quem usa username e chega sem telefone
---

Quem adota username no WhatsApp pode chegar sem telefone: a Meta omite o número quando a empresa não falou com ele nos últimos 30 dias e a pessoa não tem o número da empresa nos contatos — o caso do lead novo que vem de anúncio ou do Instagram. A identidade que vem é o BSUID (o id do usuário no escopo da empresa), e a mensagem era descartada em silêncio: não virava contato, conversa nem negócio, e a IA não respondia. Agora ela entra: o contato nasce com o BSUID e o @username, aparece na Inbox e em Contatos com o @username (ou "Cliente sem telefone"), e a resposta — da IA, da Inbox, do follow-up ou da automação — sai pelo BSUID. Quando o telefone aparece depois (no próprio webhook, ou quando a pessoa toca no botão nativo de compartilhar contato), ele entra na mesma ficha; se a pessoa já tinha uma ficha pelo telefone, as duas são unidas. Uma mensagem sem telefone e sem BSUID passa a abrir um aviso na Central em vez de sumir. O BSUID e o username entram no export do titular e são apagados na anonimização. Migration 0678; o `update.sh` aplica sozinho, sem ação do operador. Campanhas continuam exigindo telefone.
