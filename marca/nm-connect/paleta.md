# Paleta do NM Connect — vermelho e branco

| Papel | Hex | Onde entra |
|---|---|---|
| **Accent** (tema claro) | `#B3261E` | `/admin/marca` → "Cor da marca"; `APP_ACCENT_HEX` |
| **Accent escuro** (tema escuro) | `#EF6B63` | `/admin/marca` → "Cor da marca no tema escuro" |
| Branco (balão do símbolo) | `#FFFFFF` | só nos arquivos de logo/ícone |
| Tinta (texto "Connect", claro) | `#1B1A17` | só nos arquivos de logo |
| Papel (texto "Connect", escuro) | `#F2F0EA` | só nos arquivos de logo |

Os neutros e fundos (`#faf9f6` no claro, `#161510` no escuro) são do design system
(`app/globals.css`) e **não** mudam por marca.

## Por que este vermelho

- `#B3261E` é um vermelho puro e fechado (OKLCH L 0,50 · C 0,18 · H 28,7°): nem
  alaranjado nem rosado, escuro o bastante para ler como sóbrio/institucional.
- `#EF6B63` é o mesmo matiz (H 25,8°), mais claro, para não afundar no fundo escuro
  (o `#B3261E` faz só 2,80:1 sobre `#161510`).
- O sistema deriva sozinho a escala `--color-accent-50…950` (`lib/branding/css.ts`). No
  escuro ele pousou os botões em `#FF7F75`, com texto preto.

## Contraste (WCAG 2.x, fórmula de luminância relativa)

| Par | Razão | AA texto (4,5) |
|---|---|---|
| Branco sobre `#B3261E` (botão, tema claro) | **6,54:1** | passa |
| `#B3261E` sobre fundo claro `#faf9f6` | **6,21:1** | passa |
| `#EF6B63` sobre fundo escuro `#161510` | **6,05:1** | passa |
| `#161510` sobre `#EF6B63` | 6,05:1 | passa |
| Preto sobre `#FF7F75` (botão real no tema escuro, medido no DOM) | 8,54:1 | passa |
| Tinta `#1B1A17` sobre `#faf9f6` · Papel `#F2F0EA` sobre `#161510` | 16,53 · 16,04 | passa |

Medido pela própria tela `/admin/marca` depois de salvar: **6,5:1 no claro** e
**8,5:1 no escuro** (texto em cima dos botões).

## ⚠️ Risco: marca vermelha × cor de erro/ação destrutiva

**Os tokens de erro são independentes do accent, mas têm praticamente a mesma cor.**

- `app/globals.css`: `--color-error: #a94a3c` (claro) / `#c87263` (escuro), com
  `--color-error-bg` e `--color-error-fg`; `--color-destructive: var(--color-error)`.
  O botão `variant="destructive"` é `bg-error text-white` (`components/ui/button.tsx`).
  O botão primário é `--color-primary: var(--color-accent)`. Ou seja: variáveis
  separadas, nenhuma deriva da outra — mas a nossa marca caiu no mesmo matiz.
- Medido (OKLab): accent `#B3261E` × error `#a94a3c` → matiz 28,7° × 30,4°, ΔE 0,058,
  contraste entre os dois **1,16:1**. No escuro, botão `#FF7F75` × error `#c87263` →
  ΔE 0,108, contraste **1,41:1**. (Com o azul anterior o ΔE era 0,246.)
- O motor de derivação **detecta** a colisão e quer girar as semânticas para longe, mas
  esta versão não emite esse giro no CSS (`token_nao_serializado`, `css.ts`). A própria
  tela avisa depois de salvar: *"Sua cor ficou parecida com a que o sistema usa para
  indicar atenção, erro e sucesso. Nesta versão ele ainda não afasta esses tons
  sozinho"*.
- Evidência em `evidencias/erro-x-marca-*.png`:
  - **login com senha errada**: a caixa "Email ou senha incorretos" (error) fica logo
    acima do botão "Entrar" (marca). Mesma família, distinguíveis só pelo formato (caixa
    clara × botão cheio).
  - **Configurações › Organização**: "Salvar" e "Aplicar interface" (primários) ficam
    na mesma tela que "Apagar todos os dados de atendimento" (destrutivo). No claro o
    destrutivo é só um pouco mais terroso; **no escuro o "Salvar" (`#FF7F75`) chama
    mais atenção que o próprio botão de apagar (`#c87263`)**. O item ativo do menu e o
    interruptor ligado também ficam vermelhos.

**Conclusão:** dá para distinguir **pelo texto e pelo contexto**, não pela cor. O
vermelho deixa de sinalizar perigo: toda ação comum fica com cara de destrutiva.
Saídas possíveis, sem editar o upstream (decisão do Thiago):

1. **Vermelho só na identidade** (logo, ícone, materiais) e accent da interface em
   neutro escuro (grafite, por ex. `#2B2A27` / `#E8E6E0` no escuro). A marca continua
   vermelha e branca em tudo que se vê primeiro; a UI preserva o vermelho para erro.
2. **Manter o vermelho como accent** (aplicado hoje) e aceitar a ambiguidade, que o
   texto dos botões e as confirmações de ação destrutiva (diálogo) mitigam.
3. Contribuir no upstream a serialização das semânticas deslocadas — aí o próprio
   sistema giraria o erro para longe da marca.

O CSS personalizado da tela não resolve: mexer em `.bg-error` tiraria o erro do
vermelho, que é pior.

## Como aplicar

1. `/admin/marca` → Cor da marca `#B3261E`, Cor no tema escuro `#EF6B63` → **Salvar**.
2. Semente no `.env` do servidor: `APP_ACCENT_HEX=#B3261E`.
3. Não há variável de ambiente para o accent escuro: ele vive só no banco (tela).
