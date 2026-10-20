-- manifest: Resposta da IA em nota de voz — três colunas novas em `ai_agent_versions` (`voice_reply_enabled`, desligado por padrão; `voice_reply_voice`; `voice_reply_instructions`), a trava de imutabilidade cobrindo as três, e o preço do `gpt-4o-mini-tts` em `ai_pricing` para a síntese contar no teto de gasto.
-- 0677 — Quando o cliente manda NOTA DE VOZ, o agente pode responder em nota
-- de voz. Decisão do dono do produto, com quatro condições, e três delas moram
-- nesta migration:
--
--   1. DESLIGADO PARA TODO MUNDO POR PADRÃO (`not null default false`): quem
--      não mexer continua recebendo texto, byte a byte.
--   2. A ESCOLHA É POR AGENTE, na versão publicada — como a passagem por
--      assunto jurídico (0616). Mudar é criar rascunho e publicar.
--   3. A VOZ e a INSTRUÇÃO DE TOM moram junto. A voz não leva CHECK de
--      conjunto: a lista de vozes é da OpenAI e cresce
--      (`lib/messaging/voz/sintese-de-fala.ts`, `VOZES_DE_FALA`); o Zod da API
--      recusa voz desconhecida e o motor cai na padrão (`marin`) se uma chegar
--      por outro caminho. O CHECK aqui só limita o tamanho.
--   4. A ORDEM (texto aprovado por TODA a cadeia before_send antes de virar
--      voz) é do código, não do banco: `lib/agent-engine/agent/inbound-turn.ts`.
--
-- DEFENSE-IN-DEPTH: as três colunas entram em
-- `fn_ai_agent_version_content_immutable` (a ÚLTIMA definição era a da 0616,
-- com `set search_path = ''`). Sem isso, a cerca
-- `tests/unit/trigger-imutavel-cobre-todas-as-colunas-de-conteudo.test.ts`
-- reprova — e uma versão publicada ficaria editável nelas pela service key.
--
-- PREÇO: `ai_pricing` ganha `gpt-4o-mini-tts` (60 / 1200 centavos por milhão:
-- US$ 0,60 de texto de entrada e US$ 12,00 de áudio de saída, tabela "Realtime
-- and audio generation" de developers.openai.com/api/docs/pricing, conferida
-- em 2026-10-20). É a mesma tarifa de `lib/agent-engine/edge/llm/pricing.ts`,
-- e `tests/unit/preco-openai-codigo-e-tabela-concordam.test.ts` cobra os dois
-- lados. Nenhuma linha em `ai_models`: o modelo de voz não é escolha de
-- conversa e não pode aparecer no seletor de modelo do agente.
--
-- Idempotente por construção (`add column if not exists`, `drop constraint if
-- exists` antes do `add`, `create or replace`, `drop trigger if exists`,
-- `on conflict do update`): o mesmo bloco está no fim do `supabase/baseline.sql`.

alter table public.ai_agent_versions
  add column if not exists voice_reply_enabled boolean not null default false,
  add column if not exists voice_reply_voice text not null default 'marin',
  add column if not exists voice_reply_instructions text;

alter table public.ai_agent_versions
  drop constraint if exists ai_agent_versions_voice_reply_voice_tamanho;
alter table public.ai_agent_versions
  add constraint ai_agent_versions_voice_reply_voice_tamanho
  check (char_length(voice_reply_voice) between 1 and 40);

alter table public.ai_agent_versions
  drop constraint if exists ai_agent_versions_voice_reply_instructions_tamanho;
alter table public.ai_agent_versions
  add constraint ai_agent_versions_voice_reply_instructions_tamanho
  check (voice_reply_instructions is null or char_length(voice_reply_instructions) <= 500);

comment on column public.ai_agent_versions.voice_reply_enabled is
  'Responder áudio com áudio: quando a mensagem do cliente que abriu o turno é nota de voz, a resposta aprovada sai como nota de voz. Padrão DESLIGADO; falha na voz manda o texto.';
comment on column public.ai_agent_versions.voice_reply_voice is
  'Voz da OpenAI (gpt-4o-mini-tts) usada na resposta em nota de voz. Voz desconhecida cai na padrão (marin).';
comment on column public.ai_agent_versions.voice_reply_instructions is
  'Instrução de tom/sotaque/ritmo da voz (campo instructions do gpt-4o-mini-tts). Não muda o QUE é dito, só como.';

create or replace function fn_ai_agent_version_content_immutable() returns trigger
-- search_path fixo na PRÓPRIA definição: um create or replace sem a cláusula
-- apaga o alter function ... set search_path da 0521 (invariante
-- tests/invariants/avisos-do-security-advisor.test.ts).
language plpgsql set search_path = '' as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.handoff_legal_enabled  is distinct from old.handoff_legal_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.proposal_ai_draft_enabled is distinct from old.proposal_ai_draft_enabled
    or new.inbound_debounce_ms    is distinct from old.inbound_debounce_ms
    or new.voice_reply_enabled    is distinct from old.voice_reply_enabled
    or new.voice_reply_voice      is distinct from old.voice_reply_voice
    or new.voice_reply_instructions is distinct from old.voice_reply_instructions
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % é imutável (status=%): mudança de conteúdo = versão draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function fn_ai_agent_version_content_immutable();

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gpt-4o-mini-tts', 60, 1200, 'catálogo 0677 — voz: texto de entrada e áudio de saída, developers.openai.com/api/docs/pricing 2026-10-20')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;

notify pgrst, 'reload schema';
