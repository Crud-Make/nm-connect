# Paleta do NM Connect

**Regra:** a marca e a interface usam o **mesmo azul**, o da paleta do produto
(`app/globals.css`), trazida do NM ONE em 21/10/2026. Vermelho na tela só para erro e
perigo.

| Papel | Hex | Onde entra |
|---|---|---|
| Azul da marca (claro) | `#0A5ADB` | ladrilho do símbolo e "NM" em `logo.svg`, `icone.svg` e PNGs; `/admin/marca` → "Cor da marca"; `APP_ACCENT_HEX` |
| Azul da marca (escuro) | `#5794FF` | "NM" em `logo-escuro.svg`; `/admin/marca` → "Cor da marca no tema escuro" |
| Branco | `#FFFFFF` | balão do símbolo |
| Tinta / Papel (texto "Connect") | `#0F1729` / `#E7F0F9` | só nos arquivos de logo; são o texto da paleta (neutro 900 claro / 50 escuro) |

`#0A5ADB` é o grau 600 da rampa do produto e `#5794FF` o grau 400, os mesmos que a
interface pinta como accent em cada tema. O ladrilho fica `#0A5ADB` nos dois temas: é ele
que torna o ícone reconhecível na aba. Fundos (`#f8fafc` claro, `#00041a` escuro) e a cor
de erro (`#d32222` / `#ee5353`) são do design system e não mudam por marca.

## Contraste (WCAG 2.x, fórmula de luminância relativa)

| Par | Razão |
|---|---|
| Balão branco sobre o ladrilho `#0A5ADB` | **6,00:1** |
| `#0A5ADB` ("NM", ladrilho) sobre o fundo claro `#f8fafc` | **5,74:1** |
| "Connect" `#0F1729` sobre `#f8fafc` | **17,08:1** |
| "NM" `#5794FF` sobre o fundo escuro `#00041a` | **6,86:1** |
| "Connect" `#E7F0F9` sobre `#00041a` | **17,66:1** |
| Ladrilho `#0A5ADB` sobre `#00041a` / superfície `#081526` | 3,39 / 3,05 (contorno de objeto gráfico, piso 3:1) |

## Histórico

- **14/10/2026:** marca vermelha (`#B3261E`) e branca, só no logo e no ícone; interface
  em grafite (`#33363D` / `#C9CDD4`) para o vermelho não se confundir com erro.
- **O grafite neutro foi recusado:** `#2B2A27` (croma OKLCH 0,006) caiu na guarda de
  acromaticidade (`separacaoDoNeutro`, `lib/branding/contraste.ts`) e a tela voltou à cor
  padrão do produto. Por isso o grafite frio `#33363D`. Evidência em
  `evidencias/grafite-2B2A27-recusado-*.png`; as demais telas de `evidencias/` são dessa
  identidade anterior.
- **21/10/2026:** a paleta do NM ONE vira a de fábrica do produto (PR #42), e a marca
  passa a ser o mesmo azul. Logo e ícone foram regerados só com a troca de cor; a geometria
  e a tipografia não mudaram. Prévia sobre os fundos do produto, a 96, 32 e 16 px:
  `evidencias/logo-azul-previa.png`.
