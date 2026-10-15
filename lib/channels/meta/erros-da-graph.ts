/**
 * O que a Graph quis dizer — tempo de espera e mapa dos códigos de erro.
 *
 * Um lugar só para os dois transportes que falam o dialeto da Cloud API (a Meta
 * direta e o parceiro Graph-compatível): duas cópias garantiriam que o primeiro
 * código novo faltasse num lado. O PREFIXO é o que separa os dois na coluna
 * `error_code` (`meta_*` × `datafy_*`), e o mesmo prefixo que `adapter.codes`
 * já usa.
 *
 * ─── Tempo de espera ────────────────────────────────────────────────────────
 *
 * Sem `signal`, um `fetch` para a Graph que pendura a conexão espera para
 * sempre — e no envio isso segura junto o turno do agente e a request de quem
 * apertou "enviar". Os vizinhos já tinham teto (saúde 15 s, mídia 30 s,
 * digitando 5 s); o envio era o único sem.
 *
 * 25 s para ENVIO: a Graph aceita ou recusa um `POST /messages` em poucos
 * segundos (a mídia por link é baixada DEPOIS, de forma assíncrona, e falha pelo
 * webhook de status — não segura esta resposta). Folga larga sobre o normal,
 * curta perto dos 5 min do `recover-stuck-messages`, e abaixo do teto de 30 s
 * que o download de mídia, a chamada mais pesada do módulo, já usa.
 *
 * 30 s para GESTÃO de modelos (listar/criar/apagar): páginas de até 100 modelos
 * com componentes, e ninguém está esperando na conversa — o mesmo teto da mídia.
 *
 * ─── Por que o tempo esgotado NÃO reenvia ───────────────────────────────────
 *
 * Abortar a espera não prova que a Meta não entregou: o pedido pode ter chegado
 * e só a resposta ter se perdido. Por isso o aborto vira natureza `incerta` —
 * `failed` com motivo claro, sem nova tentativa automática (ver
 * `lib/channels/erro-de-envio.ts`). Já 130429/131056 chegam numa RESPOSTA de
 * recusa, sem id de mensagem: aí a Meta disse que não aceitou, e tentar depois
 * não duplica nada.
 */
import { ErroDeEnvioDoCanal, type NaturezaDaFalhaDeEnvio } from "../erro-de-envio";

export const GRAPH_TIMEOUT_ENVIO_MS = 25_000;
export const GRAPH_TIMEOUT_GESTAO_MS = 30_000;

interface Classe {
  /** Vai depois do prefixo: `meta_token_invalido`. */
  sufixo: string;
  natureza: NaturezaDaFalhaDeEnvio;
}

/**
 * Os códigos que pedem conduta DIFERENTE de "recusou, fica failed".
 *
 * Fonte: tabela de códigos de erro da Cloud API (developers.facebook.com,
 * "Error codes"). Só entra aqui código cuja conduta muda — catalogar todos
 * seria uma tabela que ninguém lê e que não altera desfecho nenhum.
 */
const MAPA: Readonly<Record<number, Classe>> = {
  // Token de acesso inválido ou vencido (OAuthException). A conexão inteira
  // parou — não é esta mensagem.
  190: { sufixo: "token_invalido", natureza: "credencial" },
  // Limite de vazão da conta/número. Recusado antes de aceitar: sem wamid.
  130429: { sufixo: "limite_de_envio", natureza: "temporaria" },
  // Limite do PAR remetente→destinatário (mensagens demais ao mesmo número em
  // pouco tempo). Também recusado antes de aceitar.
  131056: { sufixo: "limite_do_par", natureza: "temporaria" },
};

export interface ClassificacaoDaGraph {
  codigo: string;
  natureza: NaturezaDaFalhaDeEnvio;
}

/**
 * Código da Graph → `error_code` + natureza. Código desconhecido (ou ausente)
 * cai no genérico `<prefixo>_error` — o MESMO `adapter.codes.sendFailed` de
 * antes, para quem já lia esse valor não perceber diferença.
 */
export function classificarErroDaGraph(
  code: number | null | undefined,
  prefixo = "meta",
): ClassificacaoDaGraph {
  const classe = typeof code === "number" ? MAPA[code] : undefined;
  if (!classe) return { codigo: `${prefixo}_error`, natureza: "permanente" };
  return { codigo: `${prefixo}_${classe.sufixo}`, natureza: classe.natureza };
}

/** Resposta de erro da Graph → erro classificado, com a mensagem no formato de sempre. */
export function erroDaRespostaDaGraph(
  resposta: { code: number | null | undefined; status?: number; detalhe: string },
  prefixo = "meta",
): ErroDeEnvioDoCanal {
  const { codigo, natureza } = classificarErroDaGraph(resposta.code, prefixo);
  return new ErroDeEnvioDoCanal(
    codigo,
    natureza,
    `${prefixo}_${resposta.code ?? resposta.status ?? "erro"}: ${resposta.detalhe}`,
  );
}

/**
 * O `fetch` desistiu por tempo? `AbortSignal.timeout` rejeita com
 * `TimeoutError`; um `AbortController` comum, com `AbortError`. Os dois são
 * "não houve resposta" — e é só isso que importa a quem chama.
 */
export function ehTempoEsgotado(err: unknown): boolean {
  const nome = (err as { name?: unknown } | null)?.name;
  return nome === "TimeoutError" || nome === "AbortError";
}

export function erroDeTempoEsgotado(
  prefixo = "meta",
  ms = GRAPH_TIMEOUT_ENVIO_MS,
): ErroDeEnvioDoCanal {
  return new ErroDeEnvioDoCanal(
    `${prefixo}_timeout`,
    "incerta",
    `${prefixo}_timeout: a plataforma não respondeu em ${Math.round(ms / 1000)} s. ` +
      "A mensagem pode ter saído — não foi reenviada automaticamente.",
  );
}

interface RespostaDeEnvio {
  messages?: { id?: string }[];
  error?: { code?: number; message?: string; error_data?: { details?: string } };
}

/**
 * `POST /{phone_number_id}/messages` com teto de espera e erro classificado.
 *
 * Compartilhado pelos dois adapters do dialeto: a montagem do corpo é de cada
 * um; o transporte, o teto e a leitura do erro são os mesmos.
 */
export async function postarMensagemNaGraph(input: {
  url: string;
  token: string;
  corpo: Record<string, unknown>;
  prefixo: string;
}): Promise<{ externalId: string | null }> {
  let res: Response;
  try {
    res = await fetch(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.corpo),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_ENVIO_MS),
    });
  } catch (err) {
    if (ehTempoEsgotado(err)) throw erroDeTempoEsgotado(input.prefixo);
    throw err;
  }

  const body = (await res.json().catch(() => ({}))) as RespostaDeEnvio;

  if (!res.ok || body.error) {
    // `details` é o campo que diz QUAL parâmetro divergiu; sem ele o operador lê
    // "Parameter format does not match" e não tem pista nenhuma.
    throw erroDaRespostaDaGraph(
      {
        code: body.error?.code,
        status: res.status,
        detalhe: body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`,
      },
      input.prefixo,
    );
  }

  return { externalId: body.messages?.[0]?.id ?? null };
}
