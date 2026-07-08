# Guia de integração — Dexo API

Este guia foi escrito pensando no **Desmont Hub** e em outros sistemas externos
que precisam consumir os fluxos de criação de produto e anúncio do Dexo. Ele complementa a [especificação OpenAPI](./openapi.yaml) com o
passo-a-passo, exemplos prontos e checklist de produção.

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Setup inicial (uma vez por usuário)](#2-setup-inicial-uma-vez-por-usuário)
3. [Fluxo end-to-end recomendado](#3-fluxo-end-to-end-recomendado)
4. [Serviço de remoção de fundo e sombra (uso por sistemas externos)](#4-serviço-de-remoção-de-fundo-e-sombra-uso-por-sistemas-externos)
5. [Idempotência](#5-idempotência)
6. [Rate limits e caches](#6-rate-limits-e-caches)
7. [Webhooks (somente para conhecimento)](#7-webhooks-somente-para-conhecimento)
8. [Boas práticas](#8-boas-práticas)
9. [Tratamento de erros](#9-tratamento-de-erros)
10. [Checklist de integração para produção](#10-checklist-de-integração-para-produção)
11. [Exemplos prontos](#11-exemplos-prontos)
12. [Notas e roadmap](#12-notas-e-roadmap)

---

## 1. Visão geral

O Dexo expõe uma API HTTP/REST para que sistemas externos possam:

- **Cadastrar produtos** internos (com SKU, categoria, atributos, compatibilidades
  veiculares, ficha técnica, dimensões, imagens).
- **Publicar anúncios** desses produtos em **Mercado Livre** e **Shopee** (BR),
  individualmente, multi-marketplace assíncrono ou em massa (até 2000 anúncios
  por job).
- **Acompanhar** o status real de criação (já que a publicação nos marketplaces
  é assíncrona e pode falhar).

A integração foi pensada para fluxos de **autopeças**, com primeira-classe
para compatibilidade veicular, ficha técnica do Mercado Livre e categoria-folha
da Shopee.

> **Stack server-side:** Fastify 5 + Prisma + PostgreSQL.
> **Auth interna:** header `email` (ver [§2.1](#21-credenciais-internas-para-a-api-do-dexo)).
> **OAuth dos marketplaces:** configurado uma vez por usuário (ver §2.2/§2.3).

---

## 2. Setup inicial (uma vez por usuário)

### 2.1. Credenciais internas para a API do Dexo

A API do Dexo autentica cada requisição pelo **e-mail** do usuário cadastrado,
enviado no header `email`:

```
Authorization-equivalente: header `email: fefelbf@gmail.com`
```

> ⚠️ **Importante**: este mecanismo é o atual. Recomendamos encapsular o envio
> em uma camada do seu cliente HTTP — assim, quando migrarmos para JWT/Bearer
> no futuro, você troca em um único lugar.

### 2.2. Conectar conta Mercado Livre (OAuth)

```http
POST /marketplace/ml/auth
email: usuario@empresa.com
```

A resposta traz `authUrl` — abra essa URL no **navegador do usuário final**.
Após autorizar, o ML redireciona para `/marketplace/ml/callback` e a conta fica
salva como `MarketplaceAccount` ativa.

Verifique:

```http
GET /marketplace/ml/status
email: usuario@empresa.com
```

Esperado: `{ "connected": true, "platform": "MERCADO_LIVRE", "status": "ACTIVE", ... }`.

Liste todas as contas conectadas (multi-conta é suportado):

```http
GET /marketplace/ml/accounts
```

Você precisará do `accounts[].id` para usar como `accountId` ao criar anúncios.

### 2.3. Conectar conta Shopee

Análogo ao ML:

```http
POST /marketplace/shopee/auth   →  authUrl
GET  /marketplace/shopee/status →  connected: true
GET  /marketplace/shopee/accounts
```

Após conectar, **sincronize as categorias** (necessário para validar categoria-folha):

```http
POST /marketplace/shopee/sync-categories
```

> **Esses passos só precisam ser feitos uma vez por usuário.** Se uma conta for
> revogada, repita o fluxo OAuth.

---

## 3. Fluxo end-to-end recomendado

O fluxo abaixo cria 1 produto e publica anúncios em ML + Shopee em um único
ciclo. Tempo total típico: **<2s para retorno do POST**, +10-30s em background
para anúncios serem publicados.

```
                                                                       ┌── ML  (10-30s)
                                                                       │
[1] POST /upload/image          → imageUrl                             │
[2] GET  /products/next-sku     → sku sugerido                         │
[3] GET  /marketplace/ml/category-suggest?title=...   → mlCategoryId   │
[4] GET  /marketplace/shopee/category-suggest?title=  → shopeeCatId    │
[5] POST /products  com listings[] preenchido        → productId, 201 ─┤
[6] (loop) GET /listings/status?productId=...        → polling ──────  │
                                                                       └── Shopee (10-30s)
```

### Passo 1 — Upload de imagem

```bash
curl -X POST 'http://localhost:3333/upload/image' \
  -F 'file=@./parte.jpg'
```

→ Resposta:
```json
{ "success": true, "imageUrl": "http://localhost:3333/uploads/9f1b2a-...jpg", "fileName": "9f1b2a-...jpg" }
```

Guarde `imageUrl`.

### Passo 2 — SKU sugerido (opcional)

```bash
curl 'http://localhost:3333/products/next-sku' -H "email: $EMAIL"
```

→ `{ "sku": "DEXO-00043" }`. **Recomendamos** que o Desmont Hub use seu próprio
padrão (ex.: `DESMONT-{externalId}`) para manter rastreabilidade reversa — assim
o SKU funciona como chave idempotente natural (ver [§5](#5-idempotência)).

### Passo 3 — Sugerir categoria ML

```bash
curl 'http://localhost:3333/marketplace/ml/category-suggest?title=Mangueira%20radiador%20Gol%20G5' \
  -H "email: $EMAIL"
```

→ `{ "suggestions": [{ "categoryId": "MLB252712", "categoryName": "Mangueiras", "confidence": 0.87, ... }] }`

⚠️ **O sugeridor é heurístico**: confira a sugestão. Se sua confiança for baixa,
deixe o usuário escolher entre `GET /marketplace/ml/categories` (lista completa).

### Passo 4 — Sugerir categoria Shopee

```bash
curl 'http://localhost:3333/marketplace/shopee/category-suggest?title=Mangueira%20radiador' \
  -H "email: $EMAIL"
```

→ Retorna `suggestions[]` similar ao ML.

> **Lembre**: a Shopee só aceita criar anúncio em **categoria folha**. Se você
> não tem certeza, faça preflight depois ([§8](#8-boas-práticas)).

### Passo 5 — Criar produto + dispatch de anúncios

```bash
curl -X POST 'http://localhost:3333/products' \
  -H "email: $EMAIL" \
  -H 'Content-Type: application/json' \
  -d @produto.json
```

`produto.json`:
```json
{
  "sku": "DESMONT-1042",
  "name": "Mangueira radiador Gol G5 1.0 8V 2008-2014",
  "description": "Mangueira superior do radiador, original/usada em bom estado.",
  "price": 89.90,
  "stock": 2,
  "brand": "Volkswagen",
  "model": "Gol",
  "year": "2010",
  "version": "1.0 8V",
  "partNumber": "5U0121049",
  "quality": "SEMINOVO",
  "imageUrl": "http://localhost:3333/uploads/9f1b2a-....jpg",
  "imageUrls": [
    "http://localhost:3333/uploads/9f1b2a-....jpg",
    "http://localhost:3333/uploads/aa-....jpg"
  ],
  "mlCategory": "MLB252712",
  "shopeeCategory": "100018",
  "compatibilities": [
    { "brand": "Volkswagen", "model": "Gol", "yearFrom": 2008, "yearTo": 2014, "version": "1.0 8V" }
  ],
  "listings": [
    {
      "platform": "MERCADO_LIVRE",
      "categoryId": "MLB252712",
      "accountIds": ["acc_ml_01"],
      "listingType": "gold_special",
      "itemCondition": "used",
      "hasWarranty": true,
      "warrantyUnit": "dias",
      "warrantyDuration": 30,
      "shippingMode": "me2"
    },
    {
      "platform": "SHOPEE",
      "categoryId": "100018",
      "accountIds": ["acc_shopee_01"]
    }
  ]
}
```

→ `201 Created` com `productId` e `listing.pending = true`.

### Passo 6 — Polling de status

```bash
curl "http://localhost:3333/listings/status?productId=$PRODUCT_ID" \
  -H "email: $EMAIL"
```

Faça polling com **backoff exponencial**:

| Tentativa | Espera antes |
|-----------|--------------|
| 1         | 1s           |
| 2         | 2s           |
| 3         | 5s           |
| 4         | 10s          |
| 5+        | 20s (até ~60s total) |

Pare quando todos `listings[].status` saírem de `PENDING`. Após 60s, se ainda
houver `PENDING`, o `ListingRetryService` continua retentando em background;
você pode interromper o polling e checar mais tarde.

---

## 4. Serviço de remoção de fundo e sombra (uso por sistemas externos)

O Dexo expõe o mesmo pipeline de tratamento de imagem usado no cadastro de
produto como um **endpoint público e stateless**: você envia uma imagem, ele
**remove o fundo** (via IA) e, opcionalmente, aplica uma **sombra de contato**,
e devolve os **bytes da imagem processada** na resposta. **Nada é persistido** no
servidor — ideal para o Desmont Hub tratar fotos de peças sob demanda.

### Quando usar

- Recorte de foto de produto/peça com fundo transparente.
- Sombra de contato para dar profundidade à peça recortada.
- Sempre que precisar do tratamento de imagem **sem** cadastrar um produto.

### Autenticação

Igual ao resto da API: envie `Authorization: Bearer <jwt>` (recomendado) ou, no
modo legacy, o header `email: <email-cadastrado>` (ver
[§2.1](#21-credenciais-internas-para-a-api-do-dexo)).

### Requisição

```
POST /v1/images/process
Content-Type: multipart/form-data
```

| Campo | Tipo | Obrigatório | Default | Descrição |
|-------|------|-------------|---------|-----------|
| `file` | binary | sim | — | Imagem `jpeg/jpg/png/webp`, ≤ 20 MB. |
| `removeBackground` | string | não | `true` | `"true"`/`"false"`. Remove o fundo. |
| `addShadow` | string | não | `false` | `"true"`/`"false"`. Sombra de contato; exige recorte — ignorada se `removeBackground=false`. |

### Resposta (binária)

A resposta **é a imagem** — os bytes vêm no corpo. Salve-os onde quiser (a
URL/armazenamento é responsabilidade do seu sistema). Os metadados vêm em
headers:

| Header | Exemplo | Significado |
|--------|---------|-------------|
| `Content-Type` | `image/png` | `image/png` (recorte) ou `image/webp` (otimizado/fallback). |
| `X-Removed-Background` | `true` | Se o fundo foi de fato removido. |
| `X-Shadow-Applied` | `true` | Se a sombra foi aplicada. |
| `X-Image-Format` | `png` | Formato devolvido. |
| `X-Image-Width` / `X-Image-Height` | `1600` / `1200` | Dimensões (quando disponíveis). A imagem é redimensionada para a janela **1000–1600 px**. |
| `X-Warning` | (ver abaixo) | Presente **apenas** em degradação graceful. |

### Degradação graceful (importante)

Se a remoção de fundo estiver **temporariamente indisponível**, o endpoint **não
retorna erro**: você recebe `200` com a imagem apenas otimizada
(`Content-Type: image/webp`), `X-Removed-Background: false` e um header
`X-Warning`. Trate esse caso — por exemplo, marque a imagem para reprocessar
mais tarde.

### Exemplo cURL

```bash
# -D -  imprime os headers de resposta (X-Removed-Background, X-Warning, etc.)
# -o    grava os bytes da imagem processada em arquivo
curl -X POST 'http://localhost:3333/v1/images/process' \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@./parte.jpg' \
  -F 'removeBackground=true' \
  -F 'addShadow=true' \
  -D - \
  -o parte-processada.png
```

### Exemplo Node.js (fetch nativo, Node 18+)

```javascript
import { readFile, writeFile } from "node:fs/promises";

const API_BASE = process.env.API_BASE ?? "http://localhost:3333";
const TOKEN = process.env.API_TOKEN; // ou envie o header `email`

const buf = await readFile("./parte.jpg");
const fd = new FormData();
fd.append("file", new Blob([buf], { type: "image/jpeg" }), "parte.jpg");
fd.append("removeBackground", "true");
fd.append("addShadow", "true");

const res = await fetch(`${API_BASE}/v1/images/process`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: fd,
});
if (!res.ok) throw new Error(`process falhou: HTTP ${res.status}`);

const removed = res.headers.get("X-Removed-Background") === "true";
if (!removed) {
  console.warn("fundo não removido:", res.headers.get("X-Warning"));
}

// A resposta É a imagem — grave os bytes onde quiser.
const out = Buffer.from(await res.arrayBuffer());
await writeFile("parte-processada.png", out);
```

### Boas práticas

- **Timeout generoso + retry com backoff**: o processamento pode levar alguns
  segundos (depende do sidecar de IA). Recomendamos timeout ≥ 60s.
- **Rate limit**: este endpoint compartilha o limite global de **300 req/min por
  IP**. Para lotes grandes, serialize/agrupe as chamadas.
- **`X-Removed-Background: false`**: significa que só otimizamos a imagem (sem
  recorte). Decida se aceita assim ou reenvia mais tarde.
- **Armazenamento é seu**: o Dexo não guarda a imagem — persista o resultado no
  seu próprio storage/CDN.

---

## 5. Idempotência

O Dexo **não suporta** o header `Idempotency-Key`. Use o **SKU como chave de
deduplicação natural**:

| Caso | O que acontece | Como o cliente deve reagir |
|------|----------------|----------------------------|
| `POST /products` com SKU **inédito** | `201 Created` com novo `productId` | Guarde o `productId` |
| `POST /products` com SKU **já usado** | `409 Conflict` com `error: "Produto com esse sku já existe"` | Tratar como sucesso idempotente — busque o produto existente |
| `POST /listings/bulk` com mesmos `productIds` | Um **novo job** é criado, sem deduplicar | Guarde `jobId` da primeira chamada e reuse-o |
| `POST /listings/bulk/{jobId}/retry-failed` | Cria **novo job filho** apenas com itens falhos | Use após corrigir a causa raiz |

### Recomendação para o Desmont Hub

```
SKU = "DESMONT-{externalId}"
```

Onde `externalId` é o ID interno do Desmont Hub. Isso dá:

- **Determinismo**: a mesma peça gera sempre o mesmo SKU.
- **Idempotência natural**: se você reenviar por timeout, o segundo `POST`
  retorna `409` com mensagem clara.
- **Rastreabilidade reversa**: olhando o SKU no Dexo você consegue voltar ao
  registro do Desmont.

---

## 6. Rate limits e caches

A API Fastify **não impõe rate limit explícito** hoje. Há, no entanto, caches
internos que afetam a frequência ideal de chamada do cliente:

| Endpoint | TTL de cache | Implicação |
|---------|--------------|------------|
| `auth.middleware` (validação de e-mail) | 60s in-memory | OK chamar a cada request |
| `GET /marketplace/ml/categories` | 600s (`Cache-Control: private`) | Cliente pode cachear localmente também |
| `GET /marketplace/ml/categories/:id/attributes` | 600s | Idem |
| `GET /marketplace/ml/catalog/suggestions` | 120s | Idem |
| `GET /marketplace/ml/catalog/products/:id` | 300s | Idem |
| `ShopeeApiService.assertLeafCategory` | 1h | Preflight bulk é barato |

### Recomendação de throttling client-side

- Não exceda **10 req/s** sustentado por usuário em endpoints de criação.
- Para listas grandes (1000+ produtos), prefira **bulk** sobre **N chamadas single**.
- Respeite o limite de **2000 itens por job bulk** (`productIds × accounts`).

> Se você precisar de rate limit oficial (X-RateLimit-Limit/Remaining/Reset),
> abra um ticket — não está implementado hoje.

---

## 7. Webhooks (somente para conhecimento)

O Dexo **recebe** webhooks dos marketplaces, mas **não dispara** webhooks para
sistemas externos hoje:

| Endpoint | Quem chama | Para quê |
|---------|------------|---------|
| `POST /marketplace/ml/callback` | Mercado Livre | Notificações de pedidos, perguntas, etc. |
| `POST /marketplace/shopee/webhook` | Shopee | Códigos `3` (tracking) e `4` (status do pedido) |

> **Para o Desmont Hub**: você não precisa assinar nada hoje. Caso precise saber
> "anúncio X mudou de status", **faça polling** em `GET /listings/status`. Se
> webhooks externos vierem a ser implementados, anunciaremos via changelog.

---

## 8. Boas práticas

### Categoria

- **ML**: prefira informar `mlCategory` explicitamente (ID externo `MLB####`).
  O `category-suggest` é heurístico — bom para preencher o formulário, ruim
  para automação 100% sem revisão.
- **Shopee**: rode preflight antes de bulk:

  ```bash
  curl -X POST '/listings/bulk/preflight' \
    -d '{"shopeeAccountId":"acc_shopee_01","productIds":["p1","p2","p3"]}'
  ```

  Issues retornadas (`shopee_category_missing` ou `shopee_category_not_leaf`)
  precisam ser corrigidas antes — caso contrário o bulk vai falhar nesses itens.

### Compatibilidade veicular (ML)

Use o **seletor guiado** em vez de texto livre:

```
GET /marketplace/ml/compatibility/brands           → brandValueId
GET /marketplace/ml/compatibility/models?brandValueId=...  → modelValueId
GET /marketplace/ml/compatibility/vehicles?brandValueId=...&modelValueId=...
```

Texto livre frequentemente é recusado pelo ML. Os endpoints retornam
`{ valueId, valueName }` — guarde os dois (o `valueId` é o que vai no `attributes`).

### Atributos (ficha técnica ML)

Antes de criar um anúncio ML, busque os atributos da categoria:

```bash
curl '/marketplace/ml/categories/MLB252712/attributes' -H "email: $EMAIL"
```

Preencha apenas os atributos que fazem sentido. Atributos obrigatórios da
categoria (`tags.required`) precisam estar presentes no `attributes` do produto.

### Imagens

- Pré-carregue **todas** as imagens via `POST /upload/image` antes de chamar
  `POST /products`.
- Envie a primeira como `imageUrl` e o conjunto completo (incluindo a primeira)
  como `imageUrls[]`.
- Limite: **20 MB por arquivo**, formatos: `image/jpeg`, `image/png`, `image/webp`.
- Se você está migrando do Desmont Hub que já tem imagens em CDN próprio,
  baixe-e-reupload — o Dexo **só aceita** URLs servidas por ele próprio.

### Bulk vs single

| Caso | Use |
|------|-----|
| 1 produto, 1 marketplace | `POST /listings/ml` ou `POST /listings/shopee` |
| 1 produto, multi-marketplace | `POST /listings/dispatch` (assíncrono) |
| N produtos, 1+ marketplaces, com necessidade de progresso | `POST /listings/bulk` + polling |
| Migração inicial em massa do Desmont Hub | `POST /listings/bulk` com `overrideTemplate` |

---

## 9. Tratamento de erros

| HTTP | Causa típica | Como o cliente deve tratar |
|------|---------------|-----------------------------|
| `400 Bad Request` | Validação falhou (campo faltando, formato errado, categoria inexistente, conta sem credencial) | **Não retry**. Ler `error`/`message`, corrigir e reenviar. |
| `401 Unauthorized` | Header `email` ausente ou usuário não cadastrado | **Não retry**. Verificar setup. |
| `403 Forbidden` | Tentando alterar/ler recurso de outro usuário | **Não retry**. Investigar lógica do cliente. |
| `404 Not Found` | Produto/job/anúncio não existe ou não pertence ao usuário | **Não retry**. |
| `409 Conflict` | SKU duplicado | Trate como sucesso idempotente. Buscar produto existente e seguir. |
| `412 Precondition Failed` | Endpoint ML chamou serviço sem conta ML ativa | **Não retry**. Pedir para o usuário completar OAuth. |
| `500 Internal Server Error` | Erro inesperado | **Retry com backoff**. Se persistir, abrir ticket com `request.id` da resposta. |

### Estrutura de erro

```json
{ "error": "Categoria curta", "message": "Detalhe legível para humanos" }
```

ou (mais comum em validações simples):

```json
{ "error": "Mensagem direta" }
```

---

## 10. Checklist de integração para produção

Antes de promover sua integração para produção, verifique:

- [ ] **OAuth ML**: ao menos uma conta ativa por usuário do Desmont Hub.
- [ ] **OAuth Shopee**: ao menos uma conta ativa, com `sync-categories` rodado.
- [ ] **Padrão de SKU**: definido (ex.: `DESMONT-{externalId}`) e usado consistentemente.
- [ ] **Retry/idempotência**: tratamento de `409` como sucesso.
- [ ] **Polling**: backoff exponencial implementado no `GET /listings/status`.
- [ ] **Preflight Shopee**: chamado antes de qualquer bulk com `shopeeAccountId`.
- [ ] **Compatibilidades**: usadas via seletor guiado, não texto livre.
- [ ] **Imagens**: pré-uploadadas via `/upload/image`, dentro de 20MB.
- [ ] **Logs**: sua aplicação registra `productId`, `jobId` e `request.id` para auditoria.
- [ ] **Monitoramento**: dashboard com volume de `POST /products`, taxa de erro
      `4xx`/`5xx` e tempo até `status=ACTIVE`.

---

## 11. Exemplos prontos

### cURL

Veja a pasta [`./examples/curl/`](./examples/curl/):

- [`01-upload-image.sh`](./examples/curl/01-upload-image.sh)
- [`02-create-product-simple.sh`](./examples/curl/02-create-product-simple.sh)
- [`03-create-product-with-listings.sh`](./examples/curl/03-create-product-with-listings.sh)
- [`04-bulk-listings.sh`](./examples/curl/04-bulk-listings.sh)
- [`05-poll-status.sh`](./examples/curl/05-poll-status.sh)
- [`06-process-image.sh`](./examples/curl/06-process-image.sh) — remoção de fundo + sombra (resposta binária)

### Node.js

Cliente end-to-end com `fetch` nativo (Node 18+):

- [`./examples/nodejs/desmont-hub-integration.mjs`](./examples/nodejs/desmont-hub-integration.mjs)
- [`./examples/nodejs/process-image.mjs`](./examples/nodejs/process-image.mjs) — remoção de fundo + sombra (resposta binária)

```bash
node ./examples/nodejs/desmont-hub-integration.mjs
```

---

## 12. Notas e roadmap

### Diferenças entre ambientes

A spec lista 2 servers:

| Ambiente | URL | Observação |
|----------|-----|-------------|
| **Produção** | `https://api.usedexo.com.br` | API que serve `https://usedexo.com.br/` |
| **Dev local** | `http://localhost:3333` | `npm run api` — também usado como "staging" pela equipe interna |

**Não há ambiente de staging dedicado hoje.** Se você (Desmont Hub) precisar
testar antes de produção, alinhe com a equipe Dexo para subir um banco/usuário
de teste em produção, ou rodar localmente apontando para um banco isolado.

### Regional Shopee

Esta versão da documentação cobre **apenas Shopee Brasil**. Se você operar em
MX/AR/outros, abra um ticket: o backend tem lógica regional, mas o contrato
público dela ainda não foi formalizado.

### Auth futura

O mecanismo `header email` é simples e adequado para integração interna ou de
parceiros confiáveis. Em versões futuras, pretendemos migrar para Bearer JWT
com escopos. **Encapsule o envio do header** no seu cliente para minimizar
o impacto da mudança.

### Próximas evoluções da API

- Webhook **outbound** (`listing.created`, `listing.failed`, `product.created`).
- `Idempotency-Key` em `POST /products` e `POST /listings/bulk`.
- Header de rate limit (`X-RateLimit-Remaining`).

Sugestões e relatos de bugs: `fefelbf@gmail.com`.
