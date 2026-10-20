---
impacto: capacidade_nova
secao: adicionado
titulo: Com o módulo Processos, o assistente conta ao cliente como está o processo dele
---

Com o módulo "Processos (advocacia)" instalado, o assistente ganha, no pacote "Organizar a operação", a capacidade "Contar ao cliente como está o processo dele". Na conversa, quando o cliente pergunta pelo processo, o assistente primeiro pede os 3 últimos dígitos do CPF e confere com o cadastro do cliente — três erros bloqueiam por um dia e chamam a equipe na Central; cliente sem CPF no cadastro é passado direto para uma pessoa. Conferido, ele conta só os andamentos que um gerente aprovou, e só dos processos daquele cliente: rascunho nunca chega ao cliente, e o número CNJ não é dito na conversa. No pedido de acesso aos dados (LGPD), o titular passa a receber os processos dele e os andamentos aprovados; rascunhos e quem escreveu ou aprovou ficam só no relatório da equipe. Sem migration nova; o `update.sh` não pede nada ao operador.
