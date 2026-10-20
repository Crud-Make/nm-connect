---
impacto: capacidade_nova
secao: adicionado
titulo: O módulo Processos (advocacia) pode ser instalado; nesta versão ele prepara o banco
---

Em Admin › Módulos aparece o módulo "Processos (advocacia)". Instalá-lo cria, só nesta instalação, o cadastro de processos de cada cliente (número CNJ, área, fase e advogado responsável) e os andamentos escritos para o cliente, que só valem depois de aprovados por um gerente — mudar o texto de um andamento aprovado o devolve a rascunho, e o banco recusa qualquer outro caminho. Quem não instala não recebe tabela nenhuma. Nesta versão o módulo ainda não tem tela nem é usado pelo assistente: isso chega nas próximas. A anonimização de um cliente apaga o apelido dos processos dele, o número CNJ e o texto dos andamentos; juntar fichas duplicadas leva os processos para a ficha que fica. A conferência dos 3 últimos dígitos do CPF, que hoje vale para o banco de dados externo, passa a poder conferir também contra o CPF do cadastro do contato — nada muda para quem usa o banco externo. Migrations 0706 e 0707; o `update.sh` aplica sozinho, sem ação do operador.
