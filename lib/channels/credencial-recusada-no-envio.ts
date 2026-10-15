/**
 * O ENVIO descobriu que o token da conexão não vale — e a tela precisa saber.
 *
 * Sem isto, o 190 da plataforma virava só uma linha `failed` na conversa: a
 * conexão seguia "conectada" na tela, a próxima mensagem falhava igual, e o
 * operador só descobria olhando uma por uma. O vigia de saúde
 * (`app/api/v1/cron/channel-health`) chegaria à mesma conclusão — mas só na
 * próxima rodada, e só se ela não falhar.
 *
 * Usa o MECANISMO QUE JÁ EXISTE, sem tabela nova:
 *   - `channel_sessions.status = 'FAILED'` — o que a faixa de conexão caída
 *     (`listarConexoesCaidas`) e o próprio handler de envio leem;
 *   - `sincronizarSaudeDaConexao` — o aviso na Central (`agent_inbox_items`),
 *     uma vez por episódio, com o MESMO episódio `FAILED` do vigia.
 *
 * Quem FECHA o episódio continua sendo o vigia: quando o token novo responde,
 * ele grava `WORKING` e resolve o aviso. Este caminho só abre.
 *
 * Usa o admin client: quem envia pode ser um atendente sem permissão de escrever
 * na conexão. Por isso filtra `organization_id` à mão em toda consulta — o valor
 * vem do contexto do handler (fonte confiável), nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

import { DETALHE_TOKEN_RECUSADO_NO_ENVIO, sincronizarSaudeDaConexao } from "./health";

const STATUS_CREDENCIAL_RECUSADA = "FAILED";

export async function registrarCredencialRecusadaNoEnvio(
  input: { organizationId: string; channelSessionId: string },
  admin: SupabaseClient = createAdminClient(),
): Promise<"avisado" | "ja_avisado" | "resolvido" | "sem_mudanca" | "sem_sessao"> {
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, organization_id, status, display_name, phone_number")
    .eq("id", input.channelSessionId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!sessao) return "sem_sessao";

  if (sessao.status !== STATUS_CREDENCIAL_RECUSADA) {
    await admin
      .from("channel_sessions")
      .update({
        status: STATUS_CREDENCIAL_RECUSADA,
        last_status_change_at: new Date().toISOString(),
      })
      .eq("id", input.channelSessionId)
      .eq("organization_id", input.organizationId);
  }

  const apelido =
    (sessao.display_name as string | null) ?? (sessao.phone_number as string | null) ?? "sem nome";
  return sincronizarSaudeDaConexao(
    admin,
    {
      id: input.channelSessionId,
      organization_id: input.organizationId,
      status: STATUS_CREDENCIAL_RECUSADA,
    },
    {
      reachable: true,
      status: STATUS_CREDENCIAL_RECUSADA,
      detail: DETALHE_TOKEN_RECUSADO_NO_ENVIO,
    },
    apelido,
  );
}
