/**
 * GET|POST /api/v1/webhooks/meta/[token] — webhook da WhatsApp Cloud API.
 *
 * `GET` é o handshake de verificação: a Meta só começa a entregar eventos depois
 * que o endpoint devolve `hub.challenge` **em texto puro**. Envelopar em
 * `{data:...}` (o wrapper padrão da nossa API) faz a verificação falhar com uma
 * mensagem inútil no dashboard — por isso esta é a única rota do repo que
 * responde texto cru, e está aqui escrito o motivo.
 *
 * `POST` verifica HMAC **SHA-256** com o App Secret, e só então age. O outro canal
 * do repo usa SHA-512 com segredo por sessão — não reaproveite a verificação dele;
 * o detalhe está em `lib/channels/meta/webhook.ts`.
 *
 * Por que ainda existe token no path se o App Secret é global: o segredo é do APP,
 * e um app serve N WABAs de N organizações. O token amarra o payload a UMA org
 * antes de qualquer escrita — sem ele, quem conhecesse o App Secret escreveria em
 * qualquer tenant.
 *
 * ─── De onde vêm as duas credenciais (issue #850, migration 0257) ─────────────
 *
 * Do BANCO (`platform_meta_app`), não do ambiente: as duas são da INSTALAÇÃO
 * inteira, não da organização — é isto que faz o 2º número conectar sem ninguém
 * voltar na VPS para editar `.env` e reiniciar. O `.env` continua sendo o PISO
 * (rollback, e clone que ainda não aplicou a migration) e as duas fontes NÃO se
 * misturam: segredo de um lado com verify token do outro é um app que não existe,
 * e a falha é um 401 calado que ninguém liga a configuração. A precedência, o TTL
 * e esse motivo estão escritos em `lib/channels/meta/app.ts`.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { abrirArquivoDoWebhook, fecharArquivoDoWebhook } from "@/lib/channels/arquivo-de-webhook";
import { appDaMeta } from "@/lib/channels/meta/app";
import { lerEnvelopeMeta } from "@/lib/channels/meta/envelope";
import {
  desfechoDaExcecaoMeta,
  desfechoDoArquivoMeta,
  processarWebhookMeta,
} from "@/lib/channels/meta/processar-webhook";
import { verificationChallenge, verifyMetaSignature } from "@/lib/channels/meta/webhook";
import { metaSessionByWebhookToken } from "@/lib/channels/meta/session";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;
  const session = await metaSessionByWebhookToken(token);
  if (!session) return new NextResponse("not found", { status: 404 });

  // Do BANCO (platform_meta_app, migration 0257), com o `.env` como piso: é a
  // credencial da INSTALAÇÃO inteira, não da organização — e um clone que ainda
  // não aplicou a migration continua verificado pelo ambiente. Não lança nunca;
  // a precedência e o porquê estão em `lib/channels/meta/app.ts`.
  const { verifyToken } = await appDaMeta();
  const challenge = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });

  // Texto puro, sem wrapper — ver o cabeçalho.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  const session = await metaSessionByWebhookToken(token);
  if (!session) return fail("not_found", "unknown webhook token", 404, { requestId });

  const rawBody = await req.text();
  const admin = createAdminClient();

  // ─── O corpo cru vai para o arquivo ANTES de qualquer processamento ────────
  //
  // Era a única rota de entrada de mensagem que não arquivava nada. Quando a
  // ingestão falhava, a rota respondia 200 (a Meta reentregaria em loop) e
  // escrevia um `console.error` — e a mensagem do cliente se perdia, sem corpo
  // guardado e sem ninguém que a tentasse de novo. Agora a linha nasce aqui,
  // `received`, e o desfecho decide se o cron `webhook-replay` a reprocessa.
  //
  // Organização e sessão vêm do TOKEN do path (resolvidas acima), nunca do
  // corpo; `provider` vem da sessão, nunca de um literal. Os cabeçalhos de
  // credencial são filtrados por `abrirArquivoDoWebhook`; a assinatura fica,
  // porque é ela que permite reconferir depois uma recusa.
  //
  // ANTES da assinatura, como na rota genérica de canal: quem chega aqui já
  // apresentou o token certo, e uma recusa de segurança que não deixa rastro
  // de si mesma ninguém descobre que está sendo tentada.
  const arquivo = await abrirArquivoDoWebhook(admin, {
    organizationId: session.organizationId,
    channelSessionId: session.id,
    provider: session.provider,
    rawBody,
    headers: req.headers,
  });

  // Do mesmo lugar que o handshake: BANCO primeiro, `.env` como piso (0257). Sem
  // segredo nenhum configurado a verificação devolve `false` e a entrega morre em
  // 401 — que é o desfecho de hoje, e não um 500.
  const { appSecret } = await appDaMeta();
  if (!verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), appSecret ?? "")) {
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: false,
      erro: "invalid_signature",
    });
    return fail("unauthorized", "invalid_signature", 401, { requestId });
  }

  // ─── O contrato do fio, ANTES do parser ───────────────────────────────────
  //
  // Isto era `JSON.parse(rawBody)` seguido de um `as`: cast, que não confere
  // nada em execução. `parseMetaWebhook` então faz `for (const entry of
  // envelope.entry ?? [])` — e `for...of` sobre um número LANÇA. Não há
  // try/catch em volta: a exceção subia sem ninguém tratá-la (o framework
  // responde 5xx) e a Meta reentregava em backoff um corpo que nunca melhora.
  //
  // 400 e não 200: o 200 generoso desta rota existe para EVENTO QUE NÃO NOS
  // INTERESSA (a Meta reentrega o que não recebe 2xx), e um payload fora do
  // contrato não é isso — é o fio ter mudado, que ninguém pode descobrir tarde.
  // O schema é loose e todo campo é opcional, então chegar aqui exige um campo
  // que a gente LÊ vir com o tipo errado. Ver lib/channels/meta/envelope.ts.
  const leitura = lerEnvelopeMeta(rawBody);
  if (!leitura.ok) {
    await fecharArquivoDoWebhook(admin, arquivo, {
      status: "error",
      validSignature: true,
      erro: leitura.motivo,
    });
    if (leitura.motivo === "json_invalido") {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    logger.error("[meta.webhook] payload fora do contrato do canal", {
      request_id: requestId,
      campos: leitura.campos,
    });
    return fail("validation_failed", "payload fora do contrato do canal", 400, {
      requestId,
      details: { campos: leitura.campos },
    });
  }

  // O processamento mora em `lib/channels/meta/processar-webhook.ts` porque o
  // cron `webhook-replay` reprocessa o corpo arquivado pela MESMA regra.
  let resultado: Awaited<ReturnType<typeof processarWebhookMeta>>;
  try {
    resultado = await processarWebhookMeta(admin, session, leitura.envelope, requestId);
  } catch (err) {
    // Exceção no meio: a Meta recebe 5xx e reentrega (como antes), e o arquivo
    // fica marcado para o replay — se as reentregas não bastarem, o corpo
    // continua aqui.
    await fecharArquivoDoWebhook(admin, arquivo, { ...desfechoDaExcecaoMeta(err), validSignature: true });
    throw err;
  }

  const desfecho = desfechoDoArquivoMeta(resultado);
  await fecharArquivoDoWebhook(admin, arquivo, {
    status: desfecho.status,
    validSignature: true,
    erro: desfecho.erro,
  });

  // 200 SEMPRE que a assinatura confere, inclusive para evento que não nos
  // interessa: a Meta re-entrega tudo que não recebe 2xx, e recusar o que
  // ignoramos vira re-tentativa em backoff por horas. O que falhou fica no
  // arquivo, marcado para o replay.
  // `outcomes` no corpo: quem depura vê o que aconteceu com cada evento em vez de
  // ler um contador que não distingue sucesso de falha.
  return NextResponse.json(
    { received: resultado.recebidos, outcomes: resultado.desfechos },
    { status: 200 },
  );
}
