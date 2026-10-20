"use client";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { LIMITE_DA_INSTRUCAO_DE_TOM, VOZES_DE_FALA, vozValida } from "@/lib/messaging/voz/vozes";

export interface ValorDaRespostaEmAudio {
  voice_reply_enabled: boolean;
  voice_reply_voice: string;
  /** "" = sem instrução (vira null no payload). */
  voice_reply_instructions: string;
}

/**
 * Cartão "Resposta em nota de voz" na versão do agente (migration 0677).
 *
 * Desligado por padrão. O efeito mora no turno (`inbound-turn.ts`): quando a
 * mensagem do cliente que abriu o turno é nota de voz, o texto que JÁ passou
 * por todas as travas de envio é sintetizado e sai como nota de voz; qualquer
 * falha manda o mesmo texto como texto. Como as demais chaves da versão, vale
 * depois de publicar.
 */
export function RespostaEmAudio({
  value,
  onChange,
  disabled,
}: {
  value: ValorDaRespostaEmAudio;
  onChange: (patch: Partial<ValorDaRespostaEmAudio>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-medium">{t("Resposta em nota de voz")}</h3>
      <div className="flex items-center gap-2">
        <Switch
          id="voice_reply_enabled"
          checked={value.voice_reply_enabled}
          onCheckedChange={(v) => onChange({ voice_reply_enabled: v })}
          disabled={disabled}
        />
        <Label htmlFor="voice_reply_enabled">{t("Responder áudio com áudio")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Quando o cliente manda uma nota de voz, a resposta sai em nota de voz. Se ele escreve, a resposta é texto. A voz só fala o que já passou por todas as travas de envio; se ela falhar, o texto vai no lugar.",
        )}
      </p>
      {value.voice_reply_enabled ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="voice_reply_voice">{t("Voz")}</Label>
            <Select
              value={vozValida(value.voice_reply_voice)}
              onValueChange={(v) => onChange({ voice_reply_voice: v })}
              disabled={disabled}
            >
              <SelectTrigger id="voice_reply_voice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VOZES_DE_FALA.map((voz) => (
                  <SelectItem key={voz} value={voz}>
                    {voz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="voice_reply_instructions">{t("Tom da voz (opcional)")}</Label>
            <Textarea
              id="voice_reply_instructions"
              value={value.voice_reply_instructions}
              onChange={(e) => onChange({ voice_reply_instructions: e.target.value })}
              maxLength={LIMITE_DA_INSTRUCAO_DE_TOM}
              rows={2}
              placeholder={t("Ex.: fale com calma, em tom acolhedor, com sotaque paulista.")}
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "Usa a chave da OpenAI cadastrada em Provedores de IA (ou a da instalação) e conta no limite de gasto com IA.",
            )}
          </p>
        </>
      ) : null}
    </Card>
  );
}
