# Plano de fix — OLX (#172) e Facebook (#182)

Rastreável ponto-a-ponto do relatório de auditoria pré-merge (28/07/2026).
Marque `[x]` ao concluir. Refs de linha reancoradas ao código atual
(`feat/facebook-integration`); a auditoria original tinha drift de algumas linhas.

**Legenda:** ⛔ bloqueador de merge · 🐞 bug de UI · P1 = importante · P2 = pode ir depois.
**Split de branch:** parte OLX → `feat/olx-integration` · parte Facebook → `feat/facebook-integration`.

**Regra de ouro (validar cada fix):**
```bash
npx tsc --noEmit   # baseline ~103-107 erros; acima disso = regressão
npx vitest run
```

---

## Progresso

**Onda 1 (Fase 1 — blockers) — CONCLUÍDA.** `tsc`=103 · `vitest`=3000/0.
- Schema: 8 colunas da Fase 0 no `schema.prisma` + `prisma generate` (enum já tinha OLX/FACEBOOK).
- F1.0–F1.7 implementados + testes. F1.8.b só no merge real.

**Onda 2 (Fase 2 — publicação na UI) — CONCLUÍDA.** `tsc`=101 (abaixo do baseline; agentes corrigiram erros pré-existentes) · `vitest`=3000/0.
- F2.1 novo produto, F2.2 editar produto (bug "Shopee" corrigido), F2.3 editar anúncio, F2.4 massa (bug badge "Magalu" corrigido + **F1.1.f** escada OLX/FB fim-a-fim), F2.5 revisão individual (campos OLX/FB criados e renderizados), F2.6 rotas de categoria (4) + `createFacebookListing` usa categoryId + heurística de veículo estruturada.
- **Gap da Fase 2 fechado (F2.1.f):** `step-preview.tsx` ganhou abas OLX e Facebook — novos `olx-listing-preview.tsx`/`facebook-listing-preview.tsx` (molde Magalu) + view-model estendido (`showOlx`/`showFacebook`, preços e labels de conta/categoria). Wired em `create-product-dialog`.

**Onda 3 (Fase 3 — UI/filtros/permissões/relatórios) — CONCLUÍDA.** `tsc`=101 · `vitest`=3000/0 (2 specs de enumeração de plataforma atualizados: `product.repository.search`, `team-productivity`).
- F3.1–F3.11 + **F1.3.g** (campos de seller na UI + `PATCH` backend + repo `updateSellerFields`).
- **Decisões:** espelhamento de status só Facebook (Graph lê status); OLX fica fora até a *Consulta de Anúncios Publicados* (Fase 4). `getFacebookItemStatuses` = contrato Graph best-effort, pede smoke-test com token real. `olx.svg` = wordmark aproximado.

**Onda 4 (Fase 4 vínculo por SKU + Fase 5 expectativa) — PARCIAL.** `tsc`=104 · specs OLX/FB verdes.
- **Fase 4 Facebook: CONCLUÍDA.** `listCatalogItems` + `importFacebookItems` + `normalizeFacebookItem` + rotas `POST/GET /facebook/import` + roteado no cron (`importAndBuildAllAccounts`, armadilha F4.6 corrigida) + botão "Importar" na aba de sync FB.
- **Fase 4 OLX: pendente (F4.8)** — spike da *Consulta de Anúncios Publicados*, precisa doc da OLX.
- **Fase 5: CONCLUÍDA.** F5.1 (dashboards), F5.2 (`orders-list` — aviso de venda manual atrás das flags), F5.3 (`provider-factory`), F5.4 (`messages.usecase` — guard OLX/FB com erro 400 específico, sem cair no ramo ML), F5.5 (`dashboard.routes` — `views/reviews` viram `null` p/ OLX/FB, distinguível de 0 real; evento `listing_metrics` pulado).

**Onda 5 (kill-switch de runtime) — CONCLUÍDA.** Rec de Rollback da auditoria. `tsc`=104.
- `app/lib/integration-flags.ts`: `isOlxDisabled`/`isFacebookDisabled`/`isPlatformDisabled` (padrão `*_DISABLED`, lidas por chamada, sem rebuild).
- Cobertura: hook `onRequest` bloqueia todo `/marketplace/{olx,facebook}/*` (503); `POST /listings/dispatch` e `/bulk` (503); dispatch do modal de novo produto pula OLX/FB; `updateListingStatus` no-op p/ OLX/FB (cobre auto-pause do PDV, pause manual e restore de cancelamento — caminhos fora do prefixo `/marketplace`); `ListingStatusSweepService` tira FB da varredura.
- **Migrations versionadas** (as 16 antigas já eram trackeadas; a linha `prisma/migrations/` do gitignore era inócua e foi removida). 3 migrations novas. Servem apenas p/ reproduzir o schema em **dev local / banco limpo** — **o deploy em São Paulo continua por DDL manual** (F0.1–F0.8 abaixo), como manda o `MIGRACAO_BANCO_SAO_PAULO.md`. **NÃO** rodar `prisma migrate deploy` contra o banco SP.

**Próximo:** só resta **F4.8** (vínculo por SKU na OLX — depende da doc da *Consulta de Anúncios Publicados* da OLX, externo, não é nosso). Todo o resto que é nosso está feito: Fases 1–3, 5, 6 e o Facebook da Fase 4 concluídos.

---

## FASE 0 — Banco de dados (Felipe roda, ANTES do deploy)

> ⚠️ **Deploy SP = DDL manual (inalterado).** As migrations **são versionadas** neste
> repo (as 16 antigas já estavam trackeadas; a linha `prisma/migrations/` do gitignore
> não destrackeava nada e foi removida) e as 3 novas (`add_olx_platform`,
> `add_facebook_platform`, `add_olx_facebook_account_and_category_fields`) cobrem os 8
> campos + enum — mas elas servem só p/ **dev local / banco limpo**. No banco de São
> Paulo o schema evolui por **SQL manual** (F0.1–F0.8), conforme
> `MIGRACAO_BANCO_SAO_PAULO.md`: **NUNCA rodar `prisma migrate deploy/dev` contra o
> banco SP** (schema+dados = dump; qualquer processo pm2 que escreve pode colidir).
>
> ⚠️ **Se um dia alguém rodar `migrate deploy` num ambiente que já teve o DDL manual:**
> `add_olx_platform`/`add_facebook_platform` fazem `ALTER TYPE "Platform" ADD VALUE`
> **sem** `IF NOT EXISTS` e vão **falhar** ("value already exists"). Baselinar com
> `prisma migrate resolve --applied <migration>` OU trocar por `ADD VALUE IF NOT EXISTS`
> (PG 10+). Em banco limpo roda direto (PG 12+ p/ ADD VALUE em transação).

`ALTER TYPE ... ADD VALUE` é irreversível e não roda dentro de transação (PG < 12).

- [ ] **F0.1** `ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'OLX'` (item mais urgente)
- [ ] **F0.2** `ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'FACEBOOK'`
- [ ] **F0.3** Conferir: `SELECT unnest(enum_range(NULL::"Platform"));` (deve listar 5)
- [ ] **F0.4** `ProductListing`: add col `olxListId TEXT`, `fbCatalogItemId TEXT`
- [ ] **F0.5** `ProductListing`: add col `olxCategoryOverride TEXT`, `fbCategoryOverride TEXT`
- [ ] **F0.6** `Product`: add col `olxCategoryId TEXT`, `fbCategory TEXT`
- [ ] **F0.7** `MarketplaceAccount`: add col `olxSellerPhone TEXT`, `olxSellerZipcode TEXT`, `fbCatalogId TEXT`, `fbProductUrlBase TEXT` (NULL = usa .env; aditivo, não muda nada p/ Jotabê)
- [ ] **F0.8** Pós-DDL: `npx prisma generate` → `npm run build` → restart. Flags em `false`.

> ⚠️ Se o código novo subir antes do enum existir: `stock-deduction.service.ts:262-274`
> enfileira `stockSyncJob` **dentro da transação** → rollback → **cancelamento de pedido
> ML para de estornar estoque em prod**. E `listing.repository.ts:117` grava `olxListId`
> no `upsertListing` compartilhado → sem a coluna, criação de anúncio **Magalu** quebra.

---

## FASE 1 — Bloqueadores (o gate de merge)

### F1.0 ⛔ Botão "Sincronizar estoque" da OLX destrói todos os anúncios
`sync.usercase.ts:4049` carrega produto enxuto (`select: {id,sku,stock,name}`).
`syncOlxProductStock` (`:3400`, chamado em `:2963` e `:4088`) republica o anúncio
inteiro qdo estoque > 0 via `OlxPayloadBuilderService.build`, que lê `description/price/
imageUrls/quality` — nenhum trazido pelo select → **preço 0, sem foto, todos "usado"**,
overrides descartados, e reporta **sucesso**. Guard atual não protege:
`OlxCategoryResolutionService.resolveCategoryId` nunca devolve `null` (`:31` cai em `OLX_DEFAULT_CATEGORY_ID`).
Escopo: caminho durável `syncProductStock` (`:2911-2921`, `findUnique`+`include`) **não sofre**.

- [x] **F1.0.a** `syncOlxProductStock`: estoque > 0 com anúncio já ativo = **no-op**; só republicar quando o anúncio saiu do ar
- [x] **F1.0.b** Ao republicar, carregar produto **completo** (`select` de `syncAllStock` estendido p/ OLX + reload defensivo)
- [x] **F1.0.c** Passar por `ListingOverridesService.applyOverridesToProduct` antes do build
- [x] **F1.0.d** Guarda dura antes do `build`: produto parcial, `price <= 0` ou `images.length === 0` → **lança**
- [x] **F1.0.e** Teste: `syncAllStock`/`syncProductStock` OLX lean → **zero** `submitImport` (2 specs)

### F1.1 ⛔ Não existe caminho de publicação
Whitelists rejeitam plataforma nova com 400. `ListingUseCase.createListing`
(`listing.usercase.ts:396`) tem **zero chamadores** = função morta → ~2.900 linhas inalcançáveis.

- [x] **F1.1.a** `listing.routes.ts` — liberado `POST /listings/dispatch` p/ OLX+FACEBOOK
- [x] **F1.1.b** `listing.routes.ts` — liberado `POST /listings/bulk` p/ OLX+FACEBOOK
- [x] **F1.1.c** `product.routes.ts` — modal de novo produto agora enfileira dispatch de OLX/FACEBOOK
- [x] **F1.1.d** Caminho real = `ListingDispatcher` → `createOlxListing`/`createFacebookListing` (o switch `createListing:396` é dead e NÃO é o caminho do ML — deixado como está). Path destravado pelas rotas.
- [x] **F1.1.e** Ternários de skip por conta corrigidos (OLX/FB não herdam a lista de skip do Magalu)
- [x] **F1.1.f** ✅ (via Onda 2/F2.4.d): `olxIndexByAccountId`/`fbIndexByAccountId` adicionados ao `BulkOverrideTemplate` + wired fim-a-fim (repo → `buildCrossAccountOverride` → `applyOverridesAfterCreate`)

### F1.2 ⛔ Editar anúncio é no-op que responde sucesso
`updateOlxListingFields` (`listing.usercase.ts:5946`) e `updateFacebookListingFields`
(`:6212`) gravam no banco e **não chamam a API**. Também invalida `priceOverride` do bulk.

- [x] **F1.2.a** OLX: `insert` com o mesmo `id` + checa `statusCode !== 0`; honra `priceOverride`
- [x] **F1.2.b** Facebook: `FacebookApiService.updateItem` (`UPDATE` no `items_batch`) + poll; honra `priceOverride`
- [x] **F1.2.c** Teste: `listing.olx-update-fields.spec.ts` prova a chamada à API

### F1.3 ⛔ Dados de vendedor globais vazam entre clientes
`olx-constants.ts:53-54` (`SELLER_PHONE`/`SELLER_ZIPCODE`) e `facebook-constants.ts:40,61`
(`CATALOG_ID`/`PRODUCT_URL_BASE`) são env global. Multi-tenant: telefone de um cliente
vai em todos os anúncios; `retailer_id`=SKU → dois desmontes com SKU igual se sobrescrevem.

- [x] **F1.3.a** Lê das colunas de `MarketplaceAccount`, env como fallback (`?? CONST`)
- [x] **F1.3.b** `createOlxListing` — phone/zipcode por conta
- [x] **F1.3.c** `createFacebookListing` — catalogId/productUrlBase por conta
- [x] **F1.3.d** `updateListingStatus` ramos OLX e FACEBOOK
- [x] **F1.3.e** `syncOlxProductStock` (+ `confirmFacebook`/sync FB)
- [x] **F1.3.f** `catalogId` threaded em `facebook-api.service.ts` + `facebook-payload-builder.service.ts`
- [x] **F1.3.g** UI: campos de seller nas abas de conexão OLX/Facebook (feito na Onda 3 — ver F3 abaixo: `PATCH /marketplace/{olx,facebook}/accounts/:id` + `updateSellerFields`)
- [x] **F1.3.h** Teste: `listing.facebook-tenant-catalog.spec.ts` (2 tenants, mesmo SKU → catálogos distintos)

### F1.4 ⛔ Pausar falha em silêncio
`listing.usercase.ts:5506-5508`: `deleteAd` com retorno **ignorado**. OLX responde HTTP 200
com `statusCode` de erro no corpo → Dexo grava "pausado", anúncio fica no ar → alguém compra
peça já vendida. Disparado **automaticamente** pelo estoque zerado do PDV. Mesmo padrão no
ramo FACEBOOK (`setAvailability` `:5567`) e nos syncs (`sync.usercase.ts:3461` e `:3643`).

- [x] **F1.4.a** OLX pause: checa `resp.statusCode !== 0`; não grava "paused" se recusado
- [x] **F1.4.b** Facebook pause: `setAvailability` + `pollBatchUntilDone`; lança se recusado
- [x] **F1.4.c** Syncs: `pollImportUntilDone` (OLX) / `pollBatchUntilDone` (FB) antes de `SUCCESS`
- [x] **F1.4.d** Teste: `listing.olx-pause-fail.spec.ts` (statusCode ≠ 0 → falha, sem "paused")
- [x] **F1.4.e** Teste: pause Facebook com item rejeitado (`listing.facebook-tenant-catalog.spec.ts`)

### F1.5 ⛔ Anúncio com erro cai no cron de retry do ML
`createOlxListing:3866` e `createFacebookListing:6184` gravam `retryEnabled: true` no `catch`.
`listing-retry.service.ts` seleciona por `retryEnabled` **sem filtrar plataforma**, e no ramo
default chama `MLApiService.getSellerItemIds` (`:233`) → **manda token OLX/Meta p/ api.mercadolibre.com**.

- [x] **F1.5.a** `listing-retry.service.ts`: guard só deixa `MERCADO_LIVRE` seguir no caminho ML (Shopee já tratado antes)
- [x] **F1.5.b** `createOlxListing`/`createFacebookListing` gravam `retryEnabled: false` no catch
- [x] **F1.5.c** Teste: `listing-retry-platform-guard.spec.ts` (OLX/FB nunca chamam `MLApiService`)

### F1.6 ⛔ `POST /orders/import` mente
`order.routes.ts:69-77` — com `platform:"OLX"` responde `success:true, imported:0` em vez de
dizer que a plataforma não tem pedido. `:417-422` mapeia OLX/FACEBOOK → `'ML'` no `platformLabel`,
corrompendo o `net` do `StockLog`.

- [x] **F1.6.a** `order.routes.ts`: OLX/FACEBOOK → 400 "Plataforma sem API de pedidos" (não `success:true`)
- [x] **F1.6.b** `order.routes.ts`: `platformLabel` OLX/FACEBOOK próprios (não mais `'ML'`); tipo do usecase alargado

### F1.7 Colisão de SKU truncado na OLX
`olx-payload-builder.service.ts:64-70` — `buildId` trunca SKU em 19 chars, fallback `"sku"`,
**sem detecção de colisão**. Dois produtos com prefixo igual = mesmo anúncio.

- [x] **F1.7.a** `buildId`: prefixo 14 + `_` + hash djb2 base36 (4 chars) = 19; determinístico (idempotência mantida)
- [x] **F1.7.b** Teste: `olx-payload-builder.buildId.spec.ts` (colisão em 19 chars → ids distintos)

### F1.8 Conflito de merge
`prisma/schema.prisma` é o **único** conflito. `main` inseriu `compatSyncedAt`/`compatDiagnostics`
na mesma âncora. `enum Platform` está em `schema.prisma:628`.

- [x] **F1.8.a** Enum já tem `OLX`/`FACEBOOK`; 8 colunas Fase 0 no `schema.prisma`. Conflito real de `compatSyncedAt`/`compatDiagnostics` se resolve no rebase (F1.8.b)
- [ ] **F1.8.b** Confirmar auto-merge limpo no rebase real com a `main` → **só no merge (Felipe)**

---

## FASE 2 — Publicação nos 4 pontos de entrada

### F2.1 Modal de novo produto — `create-product-dialog.tsx` ✅
- [x] **F2.1.a** passo/toggle OLX e Facebook
- [x] **F2.1.b** `fetchAccounts` OLX/FB
- [x] **F2.1.c** `listingsPayload` OLX/FB
- [x] **F2.1.d** categoria (state + suggest + search) OLX/FB
- [x] **F2.1.e** auto-seleção de contas ao ligar o toggle
- [x] **F2.1.f** `<StepPreview>` ganhou abas OLX/FB (`olx-listing-preview.tsx`/`facebook-listing-preview.tsx`, view-model + caller estendidos)

### F2.2 Modal de edição — `edit-product-dialog.tsx` ✅
- [x] **F2.2.a** seções "Criar anúncio na OLX" e "no Facebook"
- [x] **F2.2.b** `dispatchRequests` OLX/FB
- [x] **F2.2.c** categoria + validação OLX/FB
- [x] **F2.2.d** 🐞 não chama mais tudo de "Shopee" (usa `platformLabel`)

### F2.3 Edição de anúncio — `edit-listing-dialog.tsx` ✅
- [x] **F2.3.a** `olxCategoryOverride`/`fbCategoryOverride` no form + payload; pause/save OLX/FB

### F2.4 Massa — `bulk-listing-wizard.tsx` ✅
- [x] **F2.4.a** type + StepAccounts + prévia da escada OLX/FB
- [x] **F2.4.b** 🐞 badge mostra a plataforma certa (não mais "Magalu")
- [x] **F2.4.c** gate do Finalizar + `reviewAccountsKey` OLX/FB
- [x] **F2.4.d** `bulk-listing-job.repository.ts` stagger maps OLX **e** FB
- [x] **F2.4.e** `listing-dispatcher.service.ts` skip + stagger + override FB + `runOne`
- [x] **F2.4.f** `use-bulk-listing-job.ts` tipo do polling
- [x] **F2.4.g** wiring wizard→per-product (hook/`buildPerProductOverrides`/`<PerProductReviewStep>`)

### F2.5 Revisão individual — `bulk-review/` ✅
- [x] **F2.5.a** `per-product-types.ts` unions + tipos + `buildPerProductOverrides`
- [x] **F2.5.b** `use-per-product-listing.ts` state + payload + suggest OLX/FB
- [x] **F2.5.c** `per-product-review-step.tsx` renderiza `<OlxListingFields>`/`<FacebookListingFields>`
- [x] **F2.5.d** `olx-listing-fields.tsx` e `facebook-listing-fields.tsx` criados (molde Magalu)

### F2.6 Rotas de categoria ✅
- [x] **F2.6.a** `GET /olx/categories` + `/olx/category-suggest` (via `OlxCategoryResolutionService`)
- [x] **F2.6.b** `GET /facebook/categories` + `/facebook/category-suggest` (via `FacebookCategoryResolutionService`)
- [x] **F2.6.c** `createFacebookListing` usa o `categoryId` (precedência categoryId > `fbCategory` > heurística)
- [x] **F2.6.d** heurística FB lê `brand`/`model`/`year`/`version`/`sourceVehicle`

---

## FASE 3 — UI, filtros, permissões e relatórios

- [x] **F3.1** Filtro "por canal" em Produtos (OLX/FB em `product-filters`, `products-list`, `product.repository`, `product-listing-category`)
- [x] **F3.2** `product-listing-badges.tsx` — badge não fica mais esmaecido com anúncio OLX/FB ativo
- [x] **F3.3** `team-productivity.ts` + `.tsx` — buckets OLX/FB próprios (não mais "Outro")
- [x] **F3.4** `dashboard.routes.ts` (`canonFromPlatform`) + `reports/*` — fatia OLX/FB no donut e PDF
- [x] **F3.5** `listing-status.ts` — vocabulário OLX/FB (+ `FACEBOOK_STATUS_MAP`)
- [x] **F3.6** `listing-status-sweep`/`refresh` — espelhamento **Facebook** (via Graph). OLX **fora de propósito** (sem leitura de status até Fase 4)
- [x] **F3.7** `mirrorListingStatusBestEffort` inclui FACEBOOK (OLX aguarda Fase 4)
- [x] **F3.8** `originPlatform` OLX/FB em view-types/card/list-view/detail
- [x] **F3.9** `fiscal-companies-manager.tsx` — usa `LISTING_PLATFORM_LABELS` (nome amigável)
- [x] **F3.10** ⚠️ `page-access.ts` — toggles OLX/FB respeitam as flags `NEXT_PUBLIC_*`
- [x] **F3.11** `public/marketplaces/olx.svg` — wordmark vetorial self-contained (aproximado; não é o asset oficial)
- [x] **F1.3.g** (Fase 1 pendente): campos de seller nas abas de conexão OLX/FB + `PATCH /marketplace/{olx,facebook}/accounts/:id` (backend) + `MarketplaceRepository.updateSellerFields`

**Não fazer** (nunca haverá dado): filtro de OLX/FB em Pedidos (`orders-filters.tsx`) nem em
Mensagens (`messages-shell.tsx`). **Já corretos, não mexer:** `marketplace-platform.ts`,
`marketplace-listing-links.ts`, `listing-status-labels.ts`, `app-sidebar.tsx`.

---

## FASE 4 — Vínculo por SKU

**Facebook: viável. ✅ CONCLUÍDA.**
- [x] **F4.1** `facebook-api.service.ts:202` — `listCatalogItems` (`GET /{catalog_id}/products`, paginação por cursor)
- [x] **F4.2** `sync.usercase.ts:849` — `importFacebookItems` (molde Magalu)
- [x] **F4.3** `listing-autodetect.usercase.ts:489` — `normalizeFacebookItem`
- [x] **F4.4** `marketplace.routes.ts:3505` — `POST /facebook/import` + `:3539` `GET /facebook/import/:importId`
- [x] **F4.5** cron via `importAndBuildAllAccounts` (`sync.usercase.ts:2126` roteia FACEBOOK)
- [x] **F4.6** ✅ armadilha corrigida: `importAndBuildAllAccounts:2125` roteia FACEBOOK p/ `importFacebookItems` (não mais `importMagaluItems`)
- [x] **F4.7** UI: botão "Importar anúncios" na aba de sync FB (`facebook-sync-tab.tsx`)

**OLX: parcial.**
- [ ] **F4.8** Spike: implementar *Consulta de Anúncios Publicados* (`published_ads_status.html`) → leitura do estado (resolve espelhamento). NÃO resolve vínculo por SKU (anúncio manual não carrega `id` do vendedor). Consultar doc OLX antes de estimar.

---

## FASE 5 — Fechar a expectativa na UI

- [x] **F5.1** `olx-dashboard.tsx` e `facebook-dashboard.tsx` — aviso: baixa unidirecional, venda manual, sem pedido/mensagem/etiqueta
- [x] **F5.2** `app/pedidos/components/orders-list.tsx` — aviso "vendas OLX/Facebook não aparecem aqui" atrás das flags `NEXT_PUBLIC_{OLX,FACEBOOK}_INTEGRATION_ENABLED`
- [x] **F5.3** `shipping/provider-factory.ts:24-30` — case OLX/FACEBOOK: "não fornece etiqueta… registre a venda manualmente"
- [x] **F5.4** `messages.usecase.ts` — `resolveAccountForUser` lança 400 específico p/ OLX/FACEBOOK (antes cairia no ramo ML e mandaria o token p/ api.mercadolibre.com)
- [x] **F5.5** `dashboard.routes.ts` — `platformHasEngagementMetrics`: `views/reviews` viram `null` (não 0) p/ OLX/FB em `/product-metrics`; evento `listing_metrics` pulado p/ essas plataformas

---

## FASE 6 — Testes

Novos casos:
- [x] **F6.1** `sync-olx-stock-lean.spec.ts` → zero `submitImport` (F1.0)
- [x] **F6.2** `listing.olx-pause-fail.spec.ts` — `statusCode ≠ 0` → falha, não grava "paused" (F1.4)
- [x] **F6.3** `listing.facebook-tenant-catalog.spec.ts` — pause FB com item rejeitado (F1.4)
- [x] **F6.4** `listing.olx-update-fields.spec.ts` — prova chamada à API (F1.2)
- [x] **F6.5** `listing.facebook-tenant-catalog.spec.ts` — 2 tenants mesmo SKU → catálogos distintos (F1.3)
- [x] **F6.6** `listing-retry-platform-guard.spec.ts` — OLX/FB não entram no `ListingRetryService` (F1.5)
- [x] **F6.7** `olx-payload-builder.buildId.spec.ts` — colisão em 19 chars → ids distintos (F1.7)
- [x] **F6.8** `sync-loop-cadence.spec.ts` — contas OLX/FACEBOOK passam pelo `runOrdersPass`/`runCatalogPass` sem disparar nenhum import
- [x] **F6.9** `first-allowed-page.spec.ts` — com as flags OLX/FB off, as páginas não são roteáveis (`isPageRoutable`) e o redirect nunca manda o colaborador para elas; prova o gating de build-time sem jsdom
- [x] **F6.10** `listing.olx-pause-fail.spec.ts` — no-op de `updateListingStatus` com `OLX_INTEGRATION_DISABLED=1` (kill-switch, Onda 5)

Atualizar os que enumeram plataforma:
- [x] **F6.11** `listing.remove.spec.ts` — verificado, verde (26 testes)
- [x] **F6.12** `listing.update-fields.spec.ts` — verificado, verde (12 testes)
- [x] **F6.13** `shipping/__tests__/provider-factory.spec.ts` — + assert OLX/FACEBOOK lançam a mensagem de venda manual (não o genérico)
- [x] **F6.14** `marketplace-platform.test.ts` — verificado, verde (4 testes)
- [x] **F6.15** `team-productivity.test.ts` + `tests/product.repository.search.spec.ts` (atualizados na Onda 3)

---

## Sequência de merge (Felipe)

- [ ] **M.1** Concluir Fases 1-6 (OLX em `feat/olx-integration`, Facebook em `feat/facebook-integration`)
- [ ] **M.2** Rebase `feat/olx-integration` na `main` · resolver `prisma/schema.prisma`
- [ ] **M.3** Merge #172 · `npx vitest run` · `npx tsc --noEmit`
- [ ] **M.4** Rebase `feat/facebook-integration` no novo `main` · merge #182
- [ ] **M.5** Fase 0 (DDL) · `npx prisma generate` · `npm run build` · `pm2 restart`
- [ ] **M.6** Flags em `false`. Ligar uma de cada vez, em conta piloto
- [ ] **M.7** Aceitação: publicar 1 peça na OLX, vender no balcão, confirmar que o anúncio sai do ar sozinho e `lastError` limpo

> ⚠️ **Ordem importa:** #182 contém os commits do #172 e os dois apontam p/ `main` —
> mergear #182 primeiro embarca o OLX inteiro e auto-fecha o #172 sem revisão.
> **Rollback:** flags são `NEXT_PUBLIC` (build-time), só escondem UI — rotas `/olx/*` e
> `/facebook/*` ficam sempre ativas. Kill-switch real = criar `OLX_INTEGRATION_DISABLED` /
> `FACEBOOK_INTEGRATION_DISABLED` de runtime (padrão dos outros `*_DISABLED`).
