---
impacto: nada_mudou
secao: corrigido
titulo: Distribuição de conversas conta a carga inteira, acima de 1000 conversas abertas
---

Com mais de 1000 conversas abertas atribuídas (ou mais de 1000 atribuições no histórico), a carga de cada atendente era lida pela metade sem aviso: o teto de capacidade deixava passar quem já estava cheio, a distribuição por menor carga errava e o rodízio esquecia quem tinha recebido por último. A tela Equipe mostrava a mesma carga cortada. Agora a contagem é feita no banco e sai certa em qualquer volume; nada muda para quem opera.
