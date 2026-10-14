# Paleta do NM Connect

| Papel | Hex | Onde entra |
|---|---|---|
| **Accent** (tema claro) | `#1D4E89` | `/admin/marca` → "Cor da marca"; `APP_ACCENT_HEX` |
| **Accent escuro** (tema escuro) | `#7FA8DB` | `/admin/marca` → "Cor da marca no tema escuro" |
| Tinta (texto do logo, claro) | `#1B1A17` | só nos arquivos de logo |
| Papel (texto do logo, escuro) | `#F2F0EA` | só nos arquivos de logo |

Os neutros e fundos (`#faf9f6` no claro, `#161510` no escuro) são do design system
(`app/globals.css`) e **não** mudam por marca — é decisão do upstream, e a paleta foi
escolhida para eles.

## Por que este azul

- **Azul-tinta, não verde.** Verde ficaria perto demais do WhatsApp, que é marca da Meta
  e é justamente o canal que o produto opera; o NM Connect precisa ser reconhecível
  como coisa *nossa* ao lado dele. Azul profundo lê como jurídico/empresarial, sóbrio,
  sem cara de "startup colorida".
- **Um matiz, dois pesos.** `#7FA8DB` é o mesmo azul, mais claro e menos saturado, para
  não sumir no fundo escuro (o `#1D4E89` faz só 2,18:1 sobre `#161510`).
- O sistema deriva sozinho a escala `--color-accent-50…950` a partir dessas sementes
  (`lib/branding/css.ts`) e ajusta o tom dos botões para manter contraste.

## Contraste (WCAG 2.x, calculado pela fórmula de luminância relativa)

| Par | Razão | AA texto normal (4,5) | AA texto grande/UI (3,0) |
|---|---|---|---|
| Branco sobre `#1D4E89` (botão, tema claro) | **8,39:1** | passa (AAA) | passa |
| `#1D4E89` sobre fundo claro `#faf9f6` (link/destaque) | **7,97:1** | passa (AAA) | passa |
| `#1D4E89` sobre fundo escuro `#161510` | 2,18:1 | **falha** — por isso existe o accent escuro | falha |
| `#7FA8DB` sobre fundo escuro `#161510` | **7,42:1** | passa (AAA) | passa |
| `#161510` sobre `#7FA8DB` (texto escuro em botão escuro) | **7,42:1** | passa (AAA) | passa |
| Branco sobre `#7FA8DB` | 2,46:1 | falha — o sistema usa texto escuro aqui | falha |
| `#7FA8DB` sobre fundo claro `#faf9f6` | 2,34:1 | falha — não usar o accent escuro no tema claro | falha |
| Tinta `#1B1A17` sobre `#faf9f6` (logo claro) | 16,53:1 | passa | passa |
| Papel `#F2F0EA` sobre `#161510` (logo escuro) | 16,04:1 | passa | passa |
| Balão branco sobre o ladrilho `#1D4E89` (ícone) | 8,39:1 | — | passa |

Medido também pela própria tela `/admin/marca` depois de salvar ("O texto em cima dos
botões"): **8,4:1 no modo claro** e **10,1:1 no modo escuro** — no escuro o sistema
pousou o botão num tom da escala (`#89b7f1`) um pouco mais claro que a semente.

## Como aplicar

1. `/admin/marca` → Cor da marca `#1D4E89`, Cor no tema escuro `#7FA8DB` → **Salvar**.
2. Semente/piso no `.env` do servidor: `APP_ACCENT_HEX=#1D4E89` (o instalador só aceita
   `#` + 6 dígitos, que é a forma que os e-mails de acesso entendem).
3. Não há variável de ambiente para o accent escuro: ele vive só no banco (tela).
