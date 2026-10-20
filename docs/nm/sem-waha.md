# NM Connect sem WAHA

O NM Connect fala com o WhatsApp só pela Cloud API oficial da Meta. O WAHA
(WhatsApp Web não oficial) que o upstream sobe em toda instalação fica
desligado. Nenhum arquivo do upstream é editado: são dois arquivos nossos,
`docker-compose.nm.yml` e `.env.nm.example`.

## Como subir

1. No `.env` da instalação, troque o bloco `WAHA_*` pelo de `.env.nm.example`.
2. Suba com o override por último:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.nm.yml --env-file .env up -d
```

Com o proxy da hospedagem (Traefik), todo `up -d` leva os três arquivos:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml \
  -f docker-compose.nm.yml --env-file .env up -d
```

Precisa do Docker Compose 2.24.4 ou mais novo, por causa da tag `!override`.

## Na máquina de desenvolvimento

O `docker-compose.local.yml` também sobe o WAHA, e o `app` e o `worker` esperam
por ele. O override `docker-compose.local.nm.yml` faz o mesmo papel do de
produção:

```bash
docker compose -f docker-compose.local.yml -f docker-compose.local.nm.yml \
  --env-file .env.local up -d
```

Ele tira o `waha` do `up` padrão (profile), solta as dependências do `app` e do
`worker` e põe no `app` os mesmos valores de `WAHA_*` do `.env.nm.example`,
porque o `local.yml` fixa `WAHA_API_BASE_URL=http://waha:3000` e isso vence o
`.env.local`. Sem o override, o próximo `up -d` recria o WAHA (imagem de 4 GB).

### Imagens prontas do GitHub

A máquina de dev não compila mais `app`, `worker` e `scheduler`. O fluxo:

1. Merge na `main`.
2. O workflow `nm-imagens` (`.github/workflows/nm-imagens.yml`) constrói as três
   imagens para linux/amd64 e publica em `ghcr.io/crud-make/nm-connect-app`,
   `-worker` e `-scheduler`, com as tags `main` e `sha-<7>`. Leva uns 15 min
   (medida do upstream, com cache); a primeira rodada, sem cache, demora mais.
   Acompanhe em Actions › nm-imagens.
3. Na máquina, no checkout principal:

```bash
scripts/nm/atualizar-stack-local.sh
```

O script baixa as três imagens e recria os três contêineres, sem `--build`. Para
voltar a um commit: `NM_IMAGEM_TAG=sha-1a2b3c4 scripts/nm/atualizar-stack-local.sh`.
O `.env.local` não muda: o padrão de `NM_IMAGEM_TAG` é `main`.

Para testar uma branch que ainda não entrou na `main`, compile como antes, com
`up -d --build` e os dois arquivos de compose. O `build:` do `local.yml` continua
lá para isso. O próximo `scripts/nm/atualizar-stack-local.sh` volta para a imagem
da `main`.

Cuidado com `up -d` sem o script: o override usa `pull_policy: always` (a tag
`main` é móvel), e se o pull falhar (sem rede, pacote ainda privado) o Compose
cai no `build:` e compila tudo nesta máquina. O script usa `--no-build` e para
com erro.

**Uma vez só, depois da primeira rodada do workflow:** o GHCR cria os pacotes
privados, e o GitHub não deixa um workflow mudar isso. Em
`https://github.com/Crud-Make?tab=packages`, abra cada um dos três pacotes
(`nm-connect-app`, `nm-connect-worker`, `nm-connect-scheduler`) › Package
settings › Danger Zone › Change visibility › Public. Assim o `pull` funciona sem
`docker login`. Enquanto estiverem privados, o pull responde `denied`.

## O que fica desligado e por quê

| Peça | Como | Efeito |
|---|---|---|
| Contêiner `waha` | `profiles: ["waha"]` no override | Não é criado. Volumes `waha-data`/`waha-media` também não. |
| `depends_on: waha` do `app` | `depends_on: !override` (só `srh`) | Sem isso o app não sobe sem o waha. Worker e scheduler não dependem do waha. |
| Cliente WAHA no app | `WAHA_API_KEY=dev_plaintext_change_me` | É o placeholder que o código lê como "não configurado": `getWahaClient()` devolve `null`, as rotas de QR respondem 503, e Conexões e onboarding mostram o aviso de serviço não configurado na opção por QR. |
| Checagem do WAHA em `/api/v1/health` | `WAHA_API_BASE_URL` aponta para um arquivo estático do próprio app | Ver abaixo. |

As quatro `WAHA_*` são `required()` em produção (`lib/env.ts`): vazias, o app
nem sobe. O valor da URL não pode ser um endereço qualquer, porque o health
faz `GET <WAHA_API_BASE_URL>/api/sessions`, e um endereço que não responde
marca o WAHA como `down`, o que deixa a rota inteira em **503**. Com
`http://127.0.0.1:3000/rastreio/v1.js?sem-waha=`, o sufixo vira query string,
o app responde 200 e o health fica 200. Em compensação, o item `waha` do
health passa a dizer `ok` sem significar nada.

O onboarding continua oferecendo "Tenho conta oficial na Meta", que não
depende do WAHA. O item "O WhatsApp desta instalação ainda não subiu" do
painel "já está de pé" fica amarelo, porque ele mede só o transporte WAHA
(`lerTransporteDeWhatsapp`).

## O que validar depois de subir

- `docker compose ... ps`: sem contêiner `waha`; `app`, `worker`, `scheduler`
  e `caddy` de pé.
- `/` responde 200 e `/app` responde 307, como manda o runbook de deploy.
- `/api/v1/health` responde 200, com `waha` em `ok`. Um 503 aqui quer dizer
  que o `.env` ficou com a URL antiga.
- O log do `worker` mostra `watchdog: WAHA indisponível — tick de
  reconciliação pulado` a cada minuto. É esperado: o compose do upstream
  fixa `WAHA_API_BASE_URL=http://waha:3000` no worker, que não resolve, e o
  watchdog só pula o tick. Ele não reenvia nada de canal sem sessão WAHA.
- Conectar um número pela opção oficial (Meta) e trocar uma mensagem nos dois
  sentidos.

## Limites conhecidos

- Os scripts do kit (`hostgator-setup-kit/install.sh`, `update.sh`) montam a
  própria lista de `-f` e **não conhecem este override**. Rodados como estão,
  eles recriam o `waha`. Por enquanto, subir e atualizar só pelo comando acima.
- `docker compose up -d waha` (nomear o serviço) ativa o profile e sobe o
  contêiner mesmo assim.

## Médio prazo: levar ao upstream

Abrir PR em `melgarafael/DeskcommCRM` com duas mudanças, para este override
deixar de existir:

1. `profiles: ["waha"]` no serviço `waha` do `docker-compose.prod.yml`, sem o
   `depends_on` do app. É o mesmo desenho que `wacalls` e `telefonia` já
   usam. Instalações existentes precisariam de `COMPOSE_PROFILES=waha` gravado
   pelo `update.sh`, sem edição manual, como pede a doutrina de packaging.
2. Em `lib/env.ts`, as `WAHA_*` deixam de ser `required()` e passam a ser
   exigidas só quando o transporte WAHA está em uso. O health volta a dizer
   `degraded`/`nao_configurado` com a URL vazia, como o código já faz em dev.
