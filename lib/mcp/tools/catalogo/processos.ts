/**
 * Capacidades de PROCESSOS — módulo opcional de advocacia (ADR-0002).
 *
 * `modulo: "processos"`: com o módulo desligado (não instalado em `/admin/modulos`), estas
 * duas entradas somem da tela de capacidades, do agente publicado e do cliente MCP externo —
 * ninguém liga o que não existe. Ver `deModuloDesligado` em `./index.ts`.
 *
 * Em "Organizar a operação", como o banco externo (`./dados-externos.ts`): o pacote de
 * atender já opera no teto de vagas por agente (`selecao-por-pacote.ts`), e empurrá-las
 * para lá recusaria a jornada inteira de atender.
 */
import { declararTools } from "./tipos";

export const TOOLS_PROCESSOS = declararTools([
  {
    name: "crm_list_processos_do_cliente",
    category: "read",
    rotulo: "Contar ao cliente como está o processo dele",
    explicacao:
      "Mostra ao assistente os processos do cliente da conversa e os andamentos que a equipe aprovou para ele, depois de conferir o CPF. Rascunho nunca chega ao cliente.",
    oQueToca: "Processos e andamentos aprovados",
    risco: "seguro",
    pacotes: ["organizar"],
    modulo: "processos",
  },
  {
    // A trava do CPF (#18) contra o cadastro do contato. Entra SOZINHA no turno
    // de quem tem a consulta acima (`pickToolsFromMcp`): sem ela, a consulta
    // recusaria para sempre.
    name: "crm_confirm_processos_identity",
    category: "write",
    rotulo: "Conferir o CPF do cliente antes de falar do processo",
    explicacao:
      "Pede ao cliente os três últimos dígitos do CPF e confere com o cadastro dele antes de contar qualquer andamento. Três erros bloqueiam por um dia e chamam a equipe.",
    oQueToca: "Conferência de identidade do cliente",
    risco: "atencao",
    pacotes: ["organizar"],
    modulo: "processos",
  },
]);
