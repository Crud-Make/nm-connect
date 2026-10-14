# Paleta do NM Connect

**Regra:** vermelho e branco são a **marca**: só no logo e no ícone. A **interface** é
grafite. Vermelho na interface fica **reservado para erro e perigo**.

| Papel | Hex | Onde entra |
|---|---|---|
| Vermelho da marca (claro) | `#B3261E` | só `logo.svg`, `icone.svg` e PNGs |
| Vermelho da marca (escuro) | `#EF6B63` | só `logo-escuro.svg` ("NM") |
| Branco | `#FFFFFF` | balão do símbolo |
| **Accent da interface** (tema claro) | `#33363D` | `/admin/marca` → "Cor da marca"; `APP_ACCENT_HEX` |
| **Accent da interface** (tema escuro) | `#C9CDD4` | `/admin/marca` → "Cor da marca no tema escuro" |
| Tinta / Papel (texto "Connect") | `#1B1A17` / `#F2F0EA` | só nos arquivos de logo |

Fundos (`#faf9f6` claro, `#161510` escuro) e a cor de erro (`--color-error: #a94a3c` /
`#c87263`) são do design system (`app/globals.css`) e não mudam por marca.

## Por que `#33363D` e não `#2B2A27`

O primeiro grafite pedido foi `#2B2A27` / `#E8E6E0`. A tela salvou, mas **o sistema
recusa accent acromático**: *"Sua cor é um tom neutro (cinza, preto ou branco), e uma cor
assim não destaca nada na tela. Os botões seguem com a cor padrão do sistema"*. Na
prática a interface voltou para o verde-sálvia do produto original (`#506d48` no claro e
`#82a077` no escuro, medidos no DOM). Quem decide é a guarda de acromaticidade
(`separacaoDoNeutro` em `lib/branding/contraste.ts`): `#2B2A27` tem croma OKLCH de 0,006
e some nos neutros quentes do produto. Evidência: `evidencias/grafite-2B2A27-recusado-*.png`.

`#33363D` / `#C9CDD4` é um **grafite frio** (croma 0,013, matiz azulado 267°). A
diferença para o `#2B2A27` é pequena (ΔE OKLab 0,051), mas basta para o sistema aceitar.
A tela confirma: *"No modo escuro, os botões usam exatamente a sua cor"*.

## Contraste (WCAG 2.x, fórmula de luminância relativa)

| Par | Razão |
|---|---|
| Branco sobre `#33363D` (botão, tema claro) | **12,10:1** |
| `#33363D` sobre o fundo `#faf9f6` | **11,49:1** |
| Texto escuro `#161510` sobre `#C9CDD4` (botão, tema escuro) | **11,46:1** |
| `#C9CDD4` sobre o fundo `#161510` | **11,46:1** |
| Medido pela tela `/admin/marca` (texto sobre botão) | **12,1:1** no claro, **13,2:1** no escuro |
| Vermelho `#B3261E` sobre `#faf9f6` · branco sobre `#B3261E` (logo/ícone) | 6,21 · 6,54 |
| `#EF6B63` sobre `#161510` (logo escuro) | 6,05 |

## Marca × erro: resolvido

| | Accent × erro, contraste | ΔE OKLab |
|---|---|---|
| Antes (accent vermelho `#B3261E` × `#a94a3c`) | 1,16:1 | 0,058 |
| Antes, escuro (botão `#FF7F75` × `#c87263`) | 1,41:1 | 0,108 |
| **Agora** (`#33363D` × `#a94a3c`) | **2,15:1** | **0,239** |
| **Agora, escuro** (`#C9CDD4` × `#c87263`) | **2,18:1** | **0,235** |

Além da luminância, a separação agora é de **matiz e croma**: o grafite é quase sem cor
(C ≈ 0,01) e o erro é vermelho (C ≈ 0,12). O aviso *"Sua cor ficou parecida com a que o
sistema usa para indicar atenção, erro e sucesso"* **sumiu** depois de salvar. Nas telas
`evidencias/erro-x-marca-*.png`, "Salvar"/"Aplicar interface" (grafite) e "Apagar todos
os dados de atendimento" (vermelho) não se confundem, e o alerta de senha errada é a
única coisa vermelha no login além do logo.

## Como aplicar

1. `/admin/marca` → Cor da marca `#33363D`, Cor no tema escuro `#C9CDD4` → **Salvar**.
   Logo, logo escuro e ícone são os PNGs vermelhos.
2. Semente no `.env` do servidor: `APP_ACCENT_HEX=#33363D`.
3. Não há variável de ambiente para o accent escuro: ele vive só no banco (tela).
