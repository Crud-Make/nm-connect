---
impacto: capacidade_nova
secao: adicionado
titulo: A conexão de banco externo pode exigir a conferência do CPF antes de o assistente mostrar dados ao cliente
---

Em Integração de dados, ao editar uma conexão, o novo interruptor "Exigir conferência de CPF antes de mostrar dados" faz o assistente, na conversa, pedir os 3 últimos dígitos do CPF e conferi-los no banco conectado antes de qualquer consulta. A conferência é feita pela função `ia.conferir_cpf(telefone, digitos)` do próprio banco, com o telefone da conversa (nunca um valor escrito pelo modelo), e o assistente recebe só "confere" ou "não confere" — o CPF não sai do banco. Uma conferência certa vale por 24 horas. Três erros bloqueiam a consulta por 24 horas, abrem um aviso na Central e o assistente passa a conversa para a equipe. O interruptor só liga com o telefone escolhido como o que identifica o cliente, e nasce desligado: nenhuma conexão existente muda. Fora da conversa (integrações, telas) nada muda. Migration 0676: coluna `require_cpf_check` e tabela `verificacoes_de_identidade`.

Refs #18.
