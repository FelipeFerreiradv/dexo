# Plano de Implementação — Integração OLX (autoupload)

> **v2** — auditado 2x contra o código real em 2026-07-14 (segunda passada
> independente pegou: path de estoque durável `syncProductStock`,
> `marketplace.usercase.ts`, template de `removeOlxListing`, guards de `PENDING_`,
> unions/labels de UI, spread da flag, e que o `tsc` não força cobrir OLX).
> Template: integração Magalu (a mais recente). Linhas são aproximadas (mudam com edições).
>
> **v3** — validado contra os docs OFICIAIS da API (portal logado, 2026-07-15).
> Fechou os 4 bloqueios de "A confirmar" e trouxe 3 correções de arquitetura:
> (1) OAuth OLX **NÃO tem `refresh_token`** — resposta = só
> `{access_token, token_type:"Bearer"}`, sem `expires_in`; a doc diz p/ SALVAR o
> token → **remover todo o refresh/circuit-breaker/mutex do §3**; (2) guardar o
> **`list_id`** (id real do anúncio na OLX, devolvido só na consulta de status) +
> a `url` (permalink), além do teu `id`/SKU; (3) hosts OAuth reais =
> `auth.olx.com.br` (o `apps.olx.com.br` é só autoupload). Contratos completos na
> seção **"Contratos reais da API"** (substitui a antiga "A confirmar").

## Contexto

O dexo já integra Mercado Livre, Shopee e Magalu (publicar anúncio + baixa de
estoque, essas com webhook de venda). Adicionar **OLX** no mesmo padrão.

**O que torna a OLX diferente (molda o desenho):**

- API **autoupload assíncrona em lote**: `PUT https://apps.olx.com.br/autoupload/import`,
  JSON `{ access_token, ad_list: [{ id, operation: insert|delete, ... }] }` (v3:
  só `insert`/`delete`; editar = `insert` com mesmo `id`).
  Retorna um **token**; consulta status depois. Não é REST per-SKU como Magalu.
- **Sem webhook de venda/pedido** → baixa de estoque **unidirecional ERP→OLX**:
  estoque zera ⇒ anúncio **removido** (`delete`); estoque volta 0→N ⇒ anúncio
  **re-inserido** (`insert`). Venda na OLX = registrada manualmente (venda balcão).
- Autoupload só tem `insert/delete` — **não tem "pausar"** (confirmado na
  doc oficial `import.html`: sem campo `status`/`state`, sem operação de ocultar).
  Logo o conceito interno "pausar" mapeia para `delete` e "reativar" para `insert`.
  **Nuance importante:** o `delete` da OLX é literalmente "**despublicar**" (não
  destruição permanente) — anúncio sai da vitrine e volta com `insert`. Diferenças
  vs. pausar do ML/Shopee/Magalu:
  - Ao repor estoque, o `insert` **re-entra na fila de revisão** da OLX
    (`pending → queued → accepted`) antes de reaparecer — **não é instantâneo**.
  - Republicação pode gerar anúncio "novo" (perda de histórico/métricas). Mitigar
    guardando o `id`/dados do anúncio no `ProductListing` e reenviando com o **mesmo
    id** (a OLX trata `insert` com id existente como edição).
  - Não há alternativa via API — pausar de verdade só manualmente no painel OLX.
  - Refletir isso na UI (a listing "pausada" na OLX = anúncio despublicado).
- Categoria = Autopeças; exige plano profissional + possível homologação do
  integrador (ver `docs/PASSO_A_PASSO_CONTA_OLX.md`).

**Decisões confirmadas com o usuário:**
- Baixa de estoque: **reusar** `StockDeductionService.pauseOnZero` +
  `StockReconciliationService`, **sem cron dedicado**. OLX só precisa do branch no
  `updateListingStatus` (paused→delete, active→insert).
- Refill 0→N: **re-inserir automático** (`reopenOnRefill`).
- Categoria: **de-para curado** espelhando `magalu-category-map.ts`.

---

## Correções vs. rascunho inicial (o que estava errado/faltando)

Primeira passada (rascunho → v1):

1. **Caminho do usecase**: é `app/marketplaces/usecases/listing.usercase.ts`
   (o rascunho citou `app/usecases/`, que não existe para isto).
2. **`classifyOlxRemoveError` NÃO entra no `updateListingStatus`**. O
   `updateListingStatus` (pausar/reativar) do Magalu só chama `patchSku` — sem
   classify. Os helpers `classify*RemoveError` são usados no fluxo de **remoção**
   (`removeMLListing` L4508 / `removeShopeeListing` L4678, via `withRetry`). Logo
   `classifyOlxRemoveError` vai no novo `removeOlxListing`, não no update de status.
3. **Sites de dispatch de plataforma omitidos** — há MAIS de um. Lista completa
   abaixo (todos precisam de branch/case OLX).
4. **Arquivos de suporte omitidos**: `app/lib/marketplace-platform.ts` (bucket de
   relatório `canonPlatform`, L33-35) e `app/lib/page-access.ts` (registro de
   páginas, L26/L43).

Segunda passada (auditoria independente v1 → v2) — o que ainda faltava:

5. **Path de estoque DURÁVEL ignorado (crítico).** `syncProductStock`
   (`sync.usercase.ts` L2911) tem switch por plataforma com `default` que rejeita
   OLX. Toda baixa de estoque enfileira `stockSyncJob` p/ **toda** listing (sem
   filtro de plataforma), consumido por `StockSyncRetryService` → `syncProductStock`.
   Sem `case OLX`, jobs OLX falham em loop. Ver §8 (reescrito).
6. **`marketplace.usercase.ts` inteiro omitido.** OAuth callback e status são
   orquestrados aqui (`handleMagaluOAuthCallback` L701, `getMagaluAccountStatus`
   L822), não só no `*-oauth.service.ts`. Ver §3.1 (novo).
7. **`removeMagaluListing` NÃO usa `withRetry`/classify** — faz try/catch inline.
   O template de `removeOlxListing` que usa `classifyOlxRemoveError` é
   `removeMLListing`/`removeShopeeListing`, não Magalu. Ver §6.
8. **Guards de PENDING_ não sinalizados.** `pauseListings`
   (`product.usercase.ts` L570-573) filtra `externalListingId && !PENDING_`, e
   `updateListingStatus` L4906 exime só `isMagalu`. OLX PRECISA gravar
   `externalListingId` = SKU/id real (não placeholder), como Magalu faz (L3354),
   senão baixa/refill pulam a listing. Ver §6.
9. **Unions/labels de UI separados do enum Prisma.** `MarketplaceListingPlatform`,
   `LISTING_PLATFORM_LABELS`, `BulkListingPlatform`, `MarketplacePlatform` (2º
   enum) e `CanonPlatform` são unions próprias — adicionar OLX ao enum Prisma NÃO
   as força. Ver §11 e §13 (novo).
10. **Flag `NEXT_PUBLIC_OLX_INTEGRATION_ENABLED` precisa de spread** em ~8
    arquivos UI cross-cutting, não só na page. Ver §12.
11. **`tsc` NÃO é rede de proteção.** Não há `Record<Platform,...>` sobre o enum
    Prisma; switches têm `default`. Os gaps são silenciosos em runtime. Ver §Verificação.

---

## 1. Schema

- `prisma/schema.prisma` — enum `Platform` (L573-577): adicionar `OLX`.
  Migration `npx prisma migrate dev --name add_olx_platform` + `prisma generate`.
  ⚠️ Postgres `ALTER TYPE ... ADD VALUE` é **não-transacional** (sem rollback limpo
  se falhar no meio) — migration só do enum, isolada.
  `MarketplaceAccount` já é genérico por `platform` — sem mudança.
  **`ProductListing` (v3):** precisa de lugar p/ o **`list_id`** da OLX (id real do
  anúncio, ≠ do `externalListingId`=SKU). Opções: reusar um campo existente
  (`permalink` guarda a `url`; conferir se há `externalSku`/campo livre) ou
  adicionar `olxListId String?`. Decidir antes da fase (b).
- **2º enum (TS, separado do Prisma):** `app/marketplaces/types/marketplace.types.ts`
  L2-6 `enum MarketplacePlatform` (ML/SHOPEE/MAGALU). Adicionar `OLX = "OLX"` se
  algum código OLX referenciar este enum (não é forçado pelo Prisma).

## 2. Constantes + de-para (novos)

- `app/marketplaces/olx/olx-constants.ts` — espelha `magalu-constants.ts`, com os
  valores REAIS (v3):
  - `AUTH_URL` = `https://auth.olx.com.br/oauth` (authorize)
  - `OAUTH_TOKEN_ENDPOINT` = `https://auth.olx.com.br/oauth/token` (POST
    `x-www-form-urlencoded`, `grant_type=authorization_code`)
  - `API_URL` = `https://apps.olx.com.br`
  - `AUTOUPLOAD_ENDPOINT` = `/autoupload/import` (PUT em lote)
  - `IMPORT_STATUS_ENDPOINT` = `/autoupload/import/{token}` (POST, polling)
  - `BASIC_USER_INFO_ENDPOINT` = `/oauth_api/basic_user_info` (POST)
  - credenciais via env, `SCOPES` (default `autoupload`), limites REAIS:
    `Subject` 2-90, `Body` 2-6000, `id` 1-19 chars (`A-Za-z0-9_{}-`),
    `images` max 20 (1ª = principal), `videos` max 1 (só YouTube),
    payload máx **1 MB**, `price` inteiro (sem decimal).
  - `validateOlxConfig()`, flag `SANDBOX`.
- `app/marketplaces/olx/olx-category-map.ts` — espelha `magalu-category-map.ts`:
  `Record<string,string>` nome-produto→código de categoria OLX de autopeças.

## 3. Services (novos)

- `app/marketplaces/services/olx-oauth.service.ts` — ⚠️ **NÃO** espelhar o refresh
  do Magalu. OLX **não tem `refresh_token`** (v3). Só precisa de:
  `generateAuthUrl` (redirect p/ `auth.olx.com.br/oauth?client_id&response_type=code&redirect_uri&scope=autoupload&state`),
  `exchangeCodeForTokens` (POST form-urlencoded → `{access_token, token_type}`),
  state Map com TTL. **Remover** `refreshAccessToken` /
  `refreshAccessTokenForAccount` / circuit-breaker / mutex — não há o que renovar.
  O `access_token` é salvo na `MarketplaceAccount` e reusado; se falhar por token
  inválido, refazer o OAuth (re-consent), não refresh.
- `app/marketplaces/services/olx-api.service.ts` (shapes REAIS, v3):
  - `submitImport(accessToken, adList): Promise<{ token, statusCode, statusMessage, errors[] }>`
    — `PUT /autoupload/import`, body `{ access_token, ad_list:[...] }`. `statusCode`:
    `0` ok, `-1` erro inesperado, `-4` validação falhou (import cancelado),
    `-6` sem permissão (exige plano profissional ativo).
  - `getImportStatus(accessToken, token): Promise<OlxImportStatus>` —
    `POST /autoupload/import/{token}`, body `{ access_token }` →
    `{ autoupload_status: "done"|"pending", ads: { "<id>": { status, operation,
    list_id, url, message, image_errors } } }`. `status`:
    pending/error/queued/accepted/refused. **Async**: poll até `done`.
    ⚠️ cada import gera um **token novo**; edições/deleções feitas no painel OLX
    NÃO refletem no token — p/ estado atual usar a Consulta de Anúncios Publicados
    (`published_ads_status.html`).
  - `upsertAd(...)` (operation `insert`; edição = insert com mesmo `id`) e
    `deleteAd(...)` (operation `delete`) — montam `ad_list` de 1 item e chamam
    `submitImport`. **operation no request = só `insert|delete`** (não existe
    "update").
- `app/marketplaces/services/olx-payload-builder.service.ts` — espelha
  `magalu-payload-builder.service.ts`: `Product`→ad OLX (id=SKU, subject=título,
  body=descrição, category, price, images[], zipcode/params). Fallbacks de marca.
- `app/marketplaces/services/olx-category-resolution.service.ts` — espelha
  `magalu-category-resolution.service.ts`: resolve categoria via
  `olx-category-map.ts` (longest-prefix) + `product.olxCategoryId` explícito.

## 3.1. Orquestração de conta — `app/marketplaces/usecases/marketplace.usercase.ts`

As rotas de OAuth/status **não** chamam o `*-oauth.service.ts` direto: passam pelo
`MarketplaceUseCase`. Espelhar os métodos Magalu:

- **`handleOlxOAuthCallback({...})`** (novo, espelha `handleMagaluOAuthCallback`
  L701) — troca `code` por tokens (via `OlxOAuthService`), faz upsert da
  `MarketplaceAccount` (platform `OLX`, status ACTIVE). Chamado por `GET /olx/callback`.
- **`getOlxAccountStatus(userId)`** (novo, espelha `getMagaluAccountStatus` L822) —
  usado por `GET /olx/status`.
- **Disconnect:** reusa o genérico `disconnectAccount(userId, accountId)` (L375) —
  é o que `DELETE /magalu` já usa (L2246). Sem método novo.

## 4. Types (novos)

- `app/marketplaces/types/olx-api.types.ts` — `OlxAd`, `OlxAdOperation`,
  `OlxImportRequest`, `OlxImportStatus`.
- `app/marketplaces/types/olx-oauth.types.ts` — token response.

## 5. Remoção — helper de classificação

- `app/marketplaces/services/listing-removal.helpers.ts` — adicionar
  `classifyOlxRemoveError(error)` (espelha `classifyMLRemoveError` L62 /
  `classifyShopeeRemoveError` L116). Mapear os erros REAIS da OLX (v3):
  - idempotent: `status: "accepted"` numa `operation: "delete"` (já saiu), ou id
    inexistente.
  - retryable: `statusCode -1` (erro inesperado), 429/5xx/timeout/network,
    `ERROR_DOWNLOADING_IMAGE`/`ERROR_UPLOADING_IMAGE` (transitório de imagem).
  - permanent: `statusCode -4` (validação), `statusCode -6` (sem permissão/plano),
    `REFUSED_*` (`REFUSED_SUSPECT_PRICE/REGION/AUTOS/DUPLICATES/GENERIC`),
    `ERROR_IMAGE_TOO_SMALL`, `NOT_ENOUGH_AD_SLOTS`.
  Usado por `withRetry`.

## 6. UseCase — `app/marketplaces/usecases/listing.usercase.ts`

Todos os pontos de dispatch por plataforma (conferidos):

- **`createListing` switch (L375)** — adicionar `case Platform.OLX: return this.createOlxListing(...)`.
- **`createOlxListing` (novo, espelhar `createMagaluListing` L3130)** — resolve
  conta, pega `access_token` da conta (SEM refresh — v3), valida
  produto/estoque/imagem, resolve categoria, monta payload, `submitImport` insert,
  poll `getImportStatus` best-effort, `upsertListing`.
  ⚠️ **Estratégia de ids (v3):** são DOIS:
  - teu **`id`/SKU** (1-19 chars) = chave que você envia no `ad_list` e usa p/
    insert/delete (idempotência). Gravar em `externalListingId`.
  - **`list_id`** = id REAL do anúncio na OLX, devolvido só na consulta de status
    quando `status: accepted`. + `url` (permalink). Persistir os dois no
    `ProductListing` (reusar `permalink` p/ `url`; **precisa de um campo p/
    `list_id`** — ver §1). São necessários p/ "ver anúncio" (§13) e p/ a Consulta
    de Anúncios Publicados.
  ⚠️ **NÃO** gravar placeholder `PENDING_` como `externalListingId`. Motivo: dois
  guards pulam listings PENDING — `pauseListings` (`product.usercase.ts` L570-573,
  filtra `externalListingId && !startsWith("PENDING_")`) e `updateListingStatus`
  (L4906-4916, exime só `isMagalu`). Magalu resolve gravando o SKU como
  `externalListingId` de propósito (comentário L3354). OLX faz igual — apesar do
  autoupload ser async, use o SKU como chave estável desde o insert.
- **`ensureFreshOlxToken`: NÃO criar (v3).** OLX não tem refresh; usar o
  `access_token` da conta direto. Se um dia a OLX adicionar expiração, revisitar.
- **`updateListingStatus` (L4880)** — branch OLX (espelha o bloco MAGALU L4968):
  `status==="paused"` → `OlxApiService.deleteAd`; `status==="active"` →
  `OlxApiService.upsertAd(insert)`; depois `ListingRepository.updateStatus`.
  Sem classify aqui (igual ao Magalu). **Guard L4906:** se OLX gravar SKU real
  (acima), passa; se um dia gravar `PENDING_`, estender a isenção para
  `isMagalu || isOlx`. **Este branch faz a baixa/refill best-effort**
  (`pauseListings`→`pauseOnZero`/`reopenOnRefill`, wired via venda balcão em
  `finance.usecase.ts` L327/L472). O caminho DURÁVEL é §8.
- **`removeListing` (L4780)** — adicionar `if (platform === Platform.OLX) return
  ListingUseCase.removeOlxListing(listingId);`.
- **`removeOlxListing` (novo)** — ⚠️ template correto é **`removeMLListing` L4508 /
  `removeShopeeListing` L4678** (que usam `withRetry({ classify: classifyOlxRemoveError })`),
  **não** `removeMagaluListing` L5052 (esse faz try/catch inline, sem classify/withRetry).
  Fluxo: `deleteAd` sob `withRetry(classifyOlxRemoveError)` + `deleteListing` local
  em idempotent/OK. Se preferir o padrão inline do Magalu, então §5
  (`classifyOlxRemoveError`) fica sem uso — escolher UM padrão, não misturar.
- **`updateListingFields` (L4828)** — branch OLX (persistência local só, como o
  Shopee L4848-4850 → `updateShopeeListingFields`, na fase 1).

## 7. Dispatcher — `app/marketplaces/services/listing-dispatcher.service.ts`

- `type ListingPlatform` (L22) + unions em ~L374, ~L427: adicionar `"OLX"`.
- `runOne` single (~L192-300): novo `else if (req.platform === "OLX")` →
  `ListingUseCase.createOlxListing(...)` (espelha bloco MAGALU L268).
- `runOne` batch (~L527-560): novo `else if (req.platform === "OLX")` (espelha
  bloco MAGALU L547) — este é o caminho de **criação em lote**, não remoção.

## 8. Baixa de estoque — DOIS caminhos disparam por venda (crítico)

Toda mudança de estoque aciona **dois** mecanismos independentes. O plano v1 só
cobria o (B).

**(A) Durável — `stockSyncJob` → `syncProductStock` (OBRIGATÓRIO, faltava).**
`StockDeductionService.applyDeductions` (L143-170) e `StockReconciliationService`
(L77-99) enfileiram um `stockSyncJob` p/ **toda** listing, **sem filtro de
plataforma**. `StockSyncRetryService.runOnce` (30s) consome → chama
`SyncUseCase.syncProductStock(productId)`, cujo switch (`sync.usercase.ts` L2911)
tem `default` que rejeita OLX (`"Plataforma OLX não suportada"`) → job falha em
loop + logs de erro a cada venda.
→ **Adicionar `case Platform.OLX` em `syncProductStock` L2911** apontando p/ um
novo `syncOlxProductStock(listing, product)` que mapeia:
`targetStock === 0` → `OlxApiService.deleteAd`; `> 0` → `OlxApiService.upsertAd(insert)`.
Isto é o lar **durável** da baixa OLX (sobrevive a crash, tem retry) — espelha
`syncMagaluProductStock` (L3189).

**(B) Best-effort — `pauseOnZero`/`reopenOnRefill` (o que o item 6 já cobre).**
`pauseOnZero` só é passado por `finance.usecase.ts` L327 (venda balcão);
`reopenOnRefill` L472. Order de marketplace **não** passa (proposital, L1515).
Chama `pauseListings` → `updateListingStatus` (branch OLX do item 6). Opt-in,
não-durável. Coexiste com (A) — ambos chamam `deleteAd`/`upsertAd`, que devem ser
**idempotentes** (autoupload com mesmo `id` = edição, delete repetido = no-op).

**Decisão:** implementar (A) é obrigatório (senão jobs falham). Se (A) cobre a
baixa completa, (B) vira redundância barata (idempotente) — manter por consistência
com ML/Shopee/Magalu ou pular o branch OLX no `updateListingStatus`. Recomendado:
implementar ambos, garantindo idempotência.

- `StockReconciliationService` (drift-repair, 15min) filtra só por
  `marketplaceAccount.status === "ACTIVE"` e inclui OLX (L61-69) — ou seja,
  **alimenta o path (A)**. Só é "seguro" DEPOIS do `case OLX` em `syncProductStock`.

## 9. Rotas — `app/routes/marketplace.routes.ts`

Bloco `/olx/*` espelhando `/magalu/*` (começa ~L2036; imports no topo L22-24):
`POST /olx/auth`, `GET /olx/callback` (redirige a `/integracoes/olx/callback`),
`GET /olx/status`, `GET /olx/accounts`, `DELETE /olx`, `GET /olx/listings`,
`GET /olx/categories`, `POST /olx/import` + `GET /olx/import/:importId`,
`POST /olx/sync` + `POST /olx/sync/:productId`. **Sem** rota de webhook (fase 1).

## 10. Env — `app/lib/env.ts`

Após `MAGALU_SANDBOX` (L71), todos `.optional()` (mesmo padrão, boot é exit-on-error):
`OLX_CLIENT_ID`, `OLX_CLIENT_SECRET`, `OLX_AUTH_URL` (`optionalUrlIsh`),
`OLX_API_URL` (`optionalUrlIsh`), `OLX_REDIRECT_URI` (`optionalUrlIsh`),
`OLX_SCOPES` (`z.string().optional()`),
`OLX_SANDBOX` (`z.enum(["true","false"]).optional().default("false")` — igual ao
`MAGALU_SANDBOX` real, com `.optional()` antes do `.default`).
Sem `OLX_WEBHOOK_SECRET` (sem webhook na fase 1).

## 11. Suporte de plataforma (novos branches)

- `app/lib/marketplace-platform.ts` — é `canonPlatform()`, bucket de **relatório
  de logs** `CREATE_LISTING` (não o enum Platform). Adicionar `if (s.includes("olx"))
  return "OLX"` na cadeia (perto de L33-35) **E** estender o union de retorno
  `type CanonPlatform` (L12) para incluir `"OLX"`. Sem isso, OLX cai em `"OUTRO"`
  nos relatórios.
- `app/lib/page-access.ts` (L26 union, L43 lista) — adicionar id `"olx"` label `"OLX"`.

## 12. UI — `app/integracoes/olx/` (espelha `app/integracoes/magalu/`)

- `page.tsx` — `assertPageAccess(session, "olx")` + flag
  `NEXT_PUBLIC_OLX_INTEGRATION_ENABLED`.
- `components/olx-dashboard.tsx` (Tabs connection/listings/sync),
  `olx-connection-tab.tsx` (OAuth popup + postMessage `OLX_OAUTH_SUCCESS`/`ERROR`),
  `olx-listings-tab.tsx`, `olx-sync-tab.tsx`, `olx-skeleton.tsx`.
- `callback/page.tsx`.
- **Ajuste UI p/ diferença OLX**: deixar claro que a baixa é unidirecional
  (ERP→OLX) e venda OLX é registrada manualmente (venda balcão). Sem "importar pedidos".
- **Spread da flag `NEXT_PUBLIC_OLX_INTEGRATION_ENABLED`** — a flag Magalu gate ~8
  arquivos UI cross-cutting; p/ OLX aparecer em wizard/filtros/badges, replicar o
  padrão em: `app/produtos/components/bulk-listing-wizard.tsx` (L76),
  `products-list.tsx` (L180), `edit-product-dialog.tsx` (L289),
  `create-product-dialog.tsx` (L289), `app/pedidos/components/orders-filters.tsx`
  (L34), `app/mensagens/components/messages-shell.tsx` (L63),
  `app/colaboradores/components/team-productivity.tsx` (L48). Sem isso, OLX só
  aparece na própria page `/integracoes/olx`.

## 13. Unions/labels de plataforma na UI (silenciosos — `tsc` não força)

Estes são unions STRING próprias, **separadas** do enum Prisma. Adicionar OLX ao
enum não os atualiza — precisam de edição manual senão a listing OLX aparece sem
label/link:

- `app/lib/marketplace-listing-links.ts` — union `MarketplaceListingPlatform` (L1)
  + `PLATFORM_LABELS: Record<...>` (L26) + builder do link do anúncio OLX (L96/L145,
  `if (listing.platform === "OLX")`). Sem isso: listing OLX sem "ver anúncio" e label
  vazio. Consumidores: `order-detail-sheet`, `products-list`, `edit-listing-dialog`,
  `marketplace-listings-dialog`, `product-detail(-sheet)`, `product-detail.tsx`.
- `app/produtos/lib/listing-status-labels.ts` (L27) — `LISTING_PLATFORM_LABELS:
  Record<MarketplaceListingPlatform,string>`: adicionar key `OLX`.
- `app/marketplaces/repositories/bulk-listing-job.repository.ts` (L4) — union
  `BulkListingPlatform`: adicionar `"OLX"` se OLX entrar no bulk-publish wizard.
- `app/lib/product-listing-category.ts` (L5) — union + branches de label de
  categoria (menor; só se OLX precisar de formatação própria).

## 14. Verificar N/A (provavelmente sem mudança — confirmar)

- `app/marketplaces/services/listing-retry.service.ts` (L188) — só special-case
  Shopee (`PENDING_SHP_`); Magalu não é tratado aqui → OLX espelhando Magalu = N/A.
  Confirmar que publish async OLX não precisa de retry por placeholder.
- `app/marketplaces/shipping/provider-factory.ts` (L24) — `default` lança
  "Plataforma não suportada para etiqueta"; OLX não tem pedido/etiqueta → nunca
  chega. Não mudar.
- `app/marketplaces/usecases/webhook.usercase.ts` — aditivo; OLX sem webhook (fase 1).
- `app/marketplaces/usecases/listing-autodetect.usercase.ts` (L315/363/427) —
  provável só p/ import; OLX não importa. Confirmar N/A.

---

## Contratos reais da API (validado 2026-07-15 nos docs oficiais)

Fonte: `developers.olx.com.br` (portal logado). Substitui a antiga "A confirmar".

**Credenciais:** NÃO é self-service. Registra-se a aplicação por **email** p/
`suporteintegrador@olxbr.com` (campos: nome do cliente, nome da app, descrição,
website, telefone, email, 1-3 redirect URIs). OLX responde com `client_id` +
`client_secret`. **Sem homologação** documentada — o registro já libera. Categoria
**Peças e acessórios = suportada via API** (tabela em `/anuncio/home.html`). Gate
real = **plano profissional ativo** (`statusCode -6` = sem permissão sem ele).

**OAuth (`/anuncio/api/oauth.html`):**
- authorize: `GET https://auth.olx.com.br/oauth?response_type=code&client_id=…&redirect_uri=…&scope=autoupload&state=…`
- token: `POST https://auth.olx.com.br/oauth/token` (`x-www-form-urlencoded`:
  `code, client_id, client_secret, redirect_uri, grant_type=authorization_code`)
- resposta: `{ "access_token": "...", "token_type": "Bearer" }` — **SEM
  `refresh_token`, SEM `expires_in`**. Doc manda salvar o token e reusar. `code`
  expira em 10 min.
- `basic_user_info`: `POST https://apps.olx.com.br/oauth_api/basic_user_info` body
  `{access_token}` → `{user_name, user_email}`.

**Import (`/anuncio/api/import.html`):** `PUT https://apps.olx.com.br/autoupload/import`
- body: `{ access_token, ad_list: [ { id (1-19 chars A-Za-z0-9_{}-), operation
  (insert|delete), category (int), Subject (2-90), Body (2-6000), Phone (10-11
  díg, DDD+num), type (s|u), price (int, sem decimal), zipcode (str num),
  phone_hidden? (bool), params? (array por categoria), images ([url], max 20, 1ª=
  principal), videos? ([url YouTube], max 1) } ] }`. Payload máx **1 MB**.
- resposta: `{ token, statusCode, statusMessage, errors[] }`. `statusCode`: `0` ok,
  `-1` erro inesperado, `-4` validação falhou, `-6` sem permissão (plano).

**Status/polling (`/anuncio/api/publishing_status.html`):**
`POST https://apps.olx.com.br/autoupload/import/{token}` body `{access_token}` →
`{ autoupload_status: "done"|"pending", ads: { "<id>": { status
(pending|error|queued|accepted|refused), operation (insert|delete|edit),
list_id, url, message[], image_errors[] } } }`. Async — poll até `done`. Cada
import = token novo; alterações no painel OLX não refletem no token.

## Ainda pendente (não bloqueia começar o código)

- **`client_id`/`client_secret`** — aguardando resposta do email a
  `suporteintegrador@olxbr.com` (só trava o E2E, não o código).
- **Códigos INT de categoria de Peças + `params` por categoria** — preencher
  `olx-category-map.ts`. Puxar das páginas por-categoria em `/anuncio/api/...`
  quando chegar na fase (b). Scaffold com TODO até lá.

## Fora de escopo (fase 2)

- Webhooks beta de lead/chat.
- Importação de pedidos (OLX não fornece).

---

## Verificação

1. `npx prisma migrate dev` aplica enum `OLX`; `npx prisma generate`.
2. `npm run build` / `tsc --noEmit`. ⚠️ **`tsc` NÃO é rede de proteção aqui:** os
   switches (`createListing`, `syncProductStock`, `syncProductData`, dispatcher)
   têm `default`, e não há `Record<Platform,...>` sobre o enum Prisma — então o
   compilador **não** obriga cobrir `OLX`. Os únicos build-breakers são os maps
   sobre unions string (§13, `Record<MarketplaceListingPlatform,...>`) e só se você
   adicionar `"OLX"` nelas. A maioria dos gaps é **runtime/silenciosa** — cobrir por
   checklist (§6-§13) e testes, não confiando no `tsc`.
3. `npm run lint`.
4. Testes: `classifyOlxRemoveError` no padrão de `__tests__` de `listing-removal`;
   teste de `olx-payload-builder`; teste de `syncProductStock` com `case OLX`
   (targetStock 0→delete, >0→insert).
5. E2E (envs `OLX_*` sandbox):
   - Conectar via `/integracoes/olx` (OAuth → conta ACTIVE via `handleOlxOAuthCallback`).
   - Publicar 1 produto → `submitImport` insert + listing persistida com
     `externalListingId` = SKU real (não `PENDING_`).
   - Zerar estoque (venda balcão) → **(A)** `stockSyncJob` → `syncProductStock` OLX
     → `deleteAd`; **(B)** `pauseOnZero` → `deleteAd`, listing `paused`. Confirmar
     idempotência (delete duplo = no-op, sem erro nos logs).
   - Repor estoque (0→N) → `syncProductStock` (targetStock>0) e/ou `reopenOnRefill`
     re-inserem (`upsertAd`).
   - Rodar `StockSyncRetryService`/`StockReconciliationService` e confirmar que jobs
     OLX **não** ficam em falha (validação do §8-A).
   - Deletar produto → `removeOlxListing` fecha o anúncio (idempotente).
6. Conferir no painel OLX que o anúncio aparece/some conforme o estoque.
7. Conferir na UI (listagens/produtos): listing OLX mostra label e link "ver
   anúncio" (validação do §13).
