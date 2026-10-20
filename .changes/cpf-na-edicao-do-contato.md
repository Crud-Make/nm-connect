---
impacto: capacidade_nova
secao: corrigido
titulo: O CPF pode ser colocado num contato que já existe, e o CPF que não pode ser cifrado é recusado em vez de sumir
---

A tela de edição do contato não tinha o campo do documento: quem chegou pelo WhatsApp ficava sem CPF para sempre, e a trava de Processos sempre passava a conversa para uma pessoa. Agora o campo existe (o rótulo segue o país da organização). Quando o contato já tem CPF, o campo mostra "Já cadastrado" e, se ficar em branco, o CPF atual é mantido. Quando a instalação não tem a chave de cifra do CPF, a edição responde 503 com a causa, em vez de dizer "Contato atualizado" e descartar o CPF. O cadastro e a importação mantêm a degradação da #2522. O stack local (`scripts/local-stack.sh up` e `scripts/nm/atualizar-stack-local.sh`) passa a semear a `cpf_key` em `private.app_secrets` a partir de `CPF_ENCRYPTION_KEY` e nunca sobrescreve uma chave que já exista. Nenhuma mudança de banco.
