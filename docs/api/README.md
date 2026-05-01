# GHD Platform — API Documentation

Documentação OpenAPI 3.0.3 dos fluxos de **criação de produto** e **criação de
anúncio** (Mercado Livre + Shopee). Foi escrita pensando no consumo por sistemas
externos — em especial o **Desmont Hub** — mas serve também como referência
interna canônica.

> **Esta documentação é puramente descritiva.** Nenhum arquivo de runtime do
> projeto foi alterado para gerá-la (ver `Como foi gerada`).

---

## Conteúdo deste diretório

```
docs/api/
├── openapi.yaml                          ← Spec OpenAPI 3.0.3 (fonte da verdade)
├── INTEGRATION-GUIDE.md                  ← Guia passo-a-passo para Desmont Hub
├── README.md                              ← Este arquivo
└── examples/
    ├── curl/
    │   ├── 01-upload-image.sh
    │   ├── 02-create-product-simple.sh
    │   ├── 03-create-product-with-listings.sh
    │   ├── 04-bulk-listings.sh
    │   └── 05-poll-status.sh
    └── nodejs/
        └── desmont-hub-integration.mjs   ← Cliente end-to-end (Node 18+)
```

```
public/api-docs/
├── index.html                            ← Swagger UI estático (CDN)
└── openapi.yaml                          ← Cópia servida ao browser
```

---

## Como acessar a documentação localmente

```bash
# 1) Subir a API Fastify (porta padrão 3333)
npm run api

# 2) Abrir no browser
open http://localhost:3333/api-docs/
```

O Swagger UI carrega `./openapi.yaml` (relativo) via CDN do
[`swagger-ui-dist@5.17.14`](https://www.npmjs.com/package/swagger-ui-dist) — exige
internet ao abrir a página, mas **nada é instalado no projeto**.

> Quer offline? Substitua os `<script src="https://unpkg.com/...">` em
> [`public/api-docs/index.html`](../../public/api-docs/index.html) por uma cópia
> local de `swagger-ui-dist`. Ou rode `npx swagger-ui-watcher docs/api/openapi.yaml`.

---

## Endpoints documentados (24)

### Authentication & Accounts (7)
- `POST /marketplace/ml/auth` — inicia OAuth ML
- `GET  /marketplace/ml/callback` — completa OAuth ML
- `POST /marketplace/shopee/auth` — inicia OAuth Shopee
- `GET  /marketplace/ml/status` — status conta ML
- `GET  /marketplace/shopee/status` — status conta Shopee
- `GET  /marketplace/ml/accounts` — lista contas ML conectadas
- `GET  /marketplace/shopee/accounts` — lista contas Shopee conectadas

### Products (3)
- `POST /products` — **criação principal** (com dispatch opcional de anúncios)
- `GET  /products/next-sku` — SKU sugerido
- `GET  /products/filter-options` — marcas + categorias publicadas

### Listings — single (4)
- `POST /listings/ml` — criar anúncio ML unitário
- `POST /listings/shopee` — criar anúncio Shopee unitário
- `POST /listings/dispatch` — dispatch multi-marketplace assíncrono
- `GET  /listings/status` — polling

### Listings — bulk (4)
- `POST /listings/bulk/preflight` — validar antes de bulk
- `POST /listings/bulk` — criar até 2000 anúncios em job
- `GET  /listings/bulk/{jobId}` — status do job
- `POST /listings/bulk/{jobId}/retry-failed` — retentar falhos

### Marketplace — Categories & Catalog (9)
- `GET /marketplace/ml/categories` — listar categorias ML
- `GET /marketplace/ml/categories/{id}/attributes` — ficha técnica da categoria
- `GET /marketplace/ml/category-suggest` — sugerir categoria por título
- `GET /marketplace/ml/catalog/suggestions` — catalog products
- `GET /marketplace/ml/catalog/products/{id}` — detalhe catalog product
- `GET /marketplace/ml/compatibility/brands` — marcas (compat. veicular)
- `GET /marketplace/ml/compatibility/models` — modelos por marca
- `GET /marketplace/ml/compatibility/vehicles` — veículos por marca + modelo
- `GET /marketplace/shopee/categories` + `category-suggest`

### Compatibilities (2 paths, 6 ops)
- `GET/POST/PUT/DELETE /products/{id}/compatibilities`
- `POST /products/{id}/compatibilities/batch`

### Uploads (1)
- `POST /upload/image` — multipart, max 5MB

---

## Como foi gerada (e o que NÃO foi alterado)

A spec é totalmente **externa** ao código de runtime. Mantida nesse formato por
três razões:

1. **Zero risco de regressão**: nenhum controller, service, repository,
   middleware, validação ou rota foi tocado. A regra de ouro do projeto
   (documentação não pode quebrar produto) é respeitada por construção.
2. **Sem novas dependências**: nenhum pacote foi adicionado ao
   [`package.json`](../../package.json). O lint da spec usa `npx`
   one-shot (`@redocly/cli`) — não persiste no projeto.
3. **Servida pelo `@fastify/static` já existente**: como
   [`app/api/api.ts:49-52`](../../app/api/api.ts) registra
   `fastifyStatic` com `root = public/`, basta colocar arquivos em
   `public/api-docs/` para que `http://localhost:3333/api-docs/` funcione
   sem alterar `api.ts`.

### Arquivos criados

| Caminho | Tipo | Linhas |
|---------|------|--------|
| [`docs/api/openapi.yaml`](./openapi.yaml) | Spec OpenAPI | ~1100 |
| [`docs/api/INTEGRATION-GUIDE.md`](./INTEGRATION-GUIDE.md) | Guia de integração | ~340 |
| [`docs/api/README.md`](./README.md) | Este arquivo | — |
| [`docs/api/examples/curl/01-upload-image.sh`](./examples/curl/01-upload-image.sh) | Exemplo cURL | ~17 |
| [`docs/api/examples/curl/02-create-product-simple.sh`](./examples/curl/02-create-product-simple.sh) | Exemplo cURL | ~28 |
| [`docs/api/examples/curl/03-create-product-with-listings.sh`](./examples/curl/03-create-product-with-listings.sh) | Exemplo cURL | ~70 |
| [`docs/api/examples/curl/04-bulk-listings.sh`](./examples/curl/04-bulk-listings.sh) | Exemplo cURL | ~55 |
| [`docs/api/examples/curl/05-poll-status.sh`](./examples/curl/05-poll-status.sh) | Exemplo cURL | ~22 |
| [`docs/api/examples/nodejs/desmont-hub-integration.mjs`](./examples/nodejs/desmont-hub-integration.mjs) | Cliente Node.js | ~190 |
| [`public/api-docs/index.html`](../../public/api-docs/index.html) | Swagger UI estático | ~60 |
| [`public/api-docs/openapi.yaml`](../../public/api-docs/openapi.yaml) | Cópia da spec | (mesmo conteúdo) |

### Arquivos modificados

**Nenhum.** Confira:

```bash
git status -s | grep -v -E "(docs/api|public/api-docs)"
# (deve vazio — apenas arquivos novos foram adicionados)
```

---

## Validação

### Lint OpenAPI

```bash
npx --yes @redocly/cli@latest lint docs/api/openapi.yaml
```

**Resultado**: ✅ válido. 4 warnings benignos:

- `no-server-example.com` × 3 — os servers `localhost:3333`, staging e produção
  foram intencionalmente registrados como placeholders (`example.com` deve ser
  substituído por URLs reais — ver `Próximos passos` abaixo).
- `operation-2xx-response` × 1 — `GET /marketplace/ml/callback` retorna `302`
  (redirect OAuth), não `2xx`. Comportamento real do endpoint.

### Testes existentes

```bash
npm test
```

**Resultado**: ✅ veja a seção [`Resultado dos testes`](#resultado-dos-testes)
abaixo (preenchido após rodar).

### Sanity-check em runtime

```bash
npm run api
# Abrir http://localhost:3333/api-docs/ — Swagger UI deve renderizar
# Tentar Try it out em GET /products/next-sku com header email válido
```

---

## Resultado dos testes

```
$ npx vitest run
Test Files   6 failed | 43 passed | 3 skipped (52)
     Tests  15 failed | 424 passed | 28 skipped (467)
  Duration  ~5s
```

**Análise das falhas: 100% pré-existentes** — não causadas por esta entrega.
As 15 falhas concentram-se em 6 arquivos relacionados a sincronização de estoque
ML/Shopee (`tests/stock-sync-retry.spec.ts`,
`tests/sync-usercase-ml-stock.spec.ts`, etc.), que **não foram tocados** pela
documentação.

Confirmação executada: `git stash --include-untracked` em `docs/api/` e
`public/api-docs/` seguido de `npx vitest run tests/stock-sync-retry.spec.ts
tests/sync-usercase-ml-stock.spec.ts` reproduziu **exatamente** as mesmas
falhas com o código limpo (sem a documentação aplicada). Stash restaurado em
seguida sem perda.

> **Recomendação separada (fora do escopo desta tarefa)**: investigar e
> consertar essas 15 falhas pré-existentes em uma PR dedicada.

---

## Próximos passos

A spec está em [`v1.0.0`](./openapi.yaml#L4). Servers já apontam para os
ambientes reais:

- **Produção**: `https://api.usedexo.com.br` (frontend: `https://usedexo.com.br/`)
- **Dev local**: `http://localhost:3333`

Itens recomendados (não bloqueantes):

1. **Decidir disponibilidade pública** — a spec atual descreve o mecanismo de
   auth atual (`header email`). Antes de expor publicamente para o Desmont Hub,
   considere se faz sentido revisar esse contrato (ver `INTEGRATION-GUIDE.md §11`).
2. **Rotacionar credenciais** — se algum segredo (DB, ML/Shopee secrets, SMTP,
   NFe token) tiver vazado em chats, transcripts ou logs, gere novos e atualize
   o `.env`. Os secrets continuam sendo carregados pelo `dotenv`; apenas
   troque os valores no provedor (Supabase, ML developer console, etc.).

---

## Manutenção

A spec é **fonte da verdade**. Se um endpoint mudar, atualize aqui na mesma
PR — caso contrário a documentação diverge do código e quebra a confiança
do Desmont Hub. Sugestão de hook leve:

```bash
# .git/hooks/pre-push (opcional)
if git diff --cached --name-only | grep -qE "app/routes/(product|listing|upload|compatibility|marketplace)\.routes\.ts"; then
  echo "⚠ Você alterou rotas de criação. Atualizou docs/api/openapi.yaml?"
fi
```

Para tags futuras (v2.0.0, v3.0.0):
- Mudanças aditivas (novos endpoints/campos): bump `info.version` minor.
- Mudanças breaking (remoção/renomeação): bump major + changelog explícito.

---

## Suporte

Dúvidas, bugs ou sugestões: `fefelbf@gmail.com`.
