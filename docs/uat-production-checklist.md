# UAT — Production Readiness Checklist

> Roteiro manual para validar os 4 fluxos críticos contra a **conta real**
> `cmn5yc4rn0000vsasmwv9m8nc` antes de declarar o sistema pronto.
>
> Execute na UI real (ou em staging se existir). Cada seção tem
> **golden path** + **edge cases**. Marque `[x]` quando validado.

## Pré-requisitos

- [ ] `npm run api` sobe limpo, `/health` retorna 200, `/ready` retorna 200.
- [ ] `npm test` verde com `--pool=forks` (Windows).
- [ ] `npm run audit:prod` rodado hoje, relatório revisado em `./audit-reports/`.
- [ ] Backup recente do banco (ou snapshot Neon disponível).
- [ ] Tokens ML e Shopee válidos (`npm run audit:tokens`).

---

## 1. Import de produtos

### Golden path

- [ ] Abrir `/products` → upload de planilha Excel pequena (5 linhas).
- [ ] Todas as linhas aparecem na tabela com SKU correto.
- [ ] `SystemLog` mostra `CREATE_PRODUCT` para cada item.
- [ ] Editar um produto → alterar preço e estoque → salvar → refresh → mudança persistiu.

### Edge cases

- [ ] Planilha com SKU duplicado → import deve rejeitar / sinalizar.
- [ ] Planilha com campo obrigatório ausente → erro claro na UI.
- [ ] Produto sem dimensões → bloqueia publicação ML com mensagem útil.

---

## 2. Publicação de anúncio — Mercado Livre

### Golden path

- [ ] Selecionar produto com dimensões e imagens preenchidas.
- [ ] Clicar em "Publicar ML" → modal de categoria aparece.
- [ ] Aceitar sugestão → publicação dispara.
- [ ] `ProductListing` criado com `externalListingId` real (não `PENDING_*`).
- [ ] Anúncio aparece no Mercado Livre quando aberto no browser.

### Edge cases

- [ ] Produto com dimensões > 150cm → UI avisa "fora do limite ML".
- [ ] Produto sem compatibilidade → UI avisa ou bloqueia.
- [ ] Token ML expirado → sistema faz refresh automaticamente e publica.
- [ ] Retry: simular falha na publicação → `ListingRetryService` retoma.

---

## 3. Publicação de anúncio — Shopee

### Golden path

- [ ] Produto com 4+ imagens → publicar Shopee.
- [ ] `ProductListing` criado com `externalListingId` real.
- [ ] Anúncio aparece no Shopee Seller Center.

### Edge cases

- [ ] Produto com apenas 1 imagem → Shopee exige mínimo, UI avisa.
- [ ] Token Shopee expirado → refresh automático.
- [ ] Multi-shop: publicar no shop A não duplica no shop B.

---

## 4. Import de pedidos ML/Shopee

### Golden path

- [ ] Disparar sync manual de pedidos (ou aguardar loop).
- [ ] Novo `Order` aparece em `/orders` com `OrderItem` vinculado a `productListingId`.
- [ ] `StockLog` criado com o `orderId` na `reason`.
- [ ] `Product.stock` decrementou na quantidade correta.

### Edge cases

- [ ] Pedido cujo item aponta para listing legacy → fallback cria `ProductListing LEGACY_*` sem crash.
- [ ] Webhook duplicado → idempotency impede dupla dedução.
- [ ] Webhook para conta desconectada → ignorado silenciosamente.
- [ ] Pedido que deixaria estoque negativo → `OVERSELL_DETECTED` no SystemLog, stock cai para 0 (não fica negativo).

---

## 5. Stock sync cross-marketplace

### Golden path

- [ ] Produto com listing em **ML + Shopee** simultaneamente.
- [ ] Criar venda via ML (ou simular webhook).
- [ ] `StockSyncJob` enfileirado no mesmo `$transaction` da dedução.
- [ ] Em < 2min, `Shopee.stock` reflete o novo valor.
- [ ] `audit:stock` não reporta drift.

### Edge cases

- [ ] `StockSyncJob` falha uma vez → retry agenda `nextRunAt` exponencial.
- [ ] Drift artificial (mudar stock direto no banco) → `StockReconciliationService` detecta e enfileira correção.
- [ ] Produto com 0 listings ativos → dedução funciona sem enfileirar job.

---

## 6. Logs e observabilidade

### Golden path

- [ ] Abrir `/logs` → lista popula, paginação funciona.
- [ ] Filtrar por `level=ERROR` nas últimas 24h.
- [ ] Filtrar por `action=SYSTEM_ERROR` → deve estar vazio em um dia saudável.
- [ ] Rodar `npm run audit:logs` e bater resumo com a UI.

### Edge cases

- [ ] Qualquer `OVERSELL_DETECTED` → investigar o produto referenciado.
- [ ] Pico de `SYSTEM_ERROR` → abrir o stack trace em `details`.

---

## 7. Resiliência de processo

- [ ] `SIGINT` (Ctrl+C) no `npm run api` → shutdown gracioso, serviços param, prisma desconecta.
- [ ] Renomear `.env` temporariamente → `npm run api` falha imediato com mensagem clara.
- [ ] Forçar `unhandledRejection` em dev → logado em `SystemLog` sem derrubar o processo.

---

## Gate final

- [ ] Todos os itens acima marcados.
- [ ] `audit:prod` sem findings críticos.
- [ ] Zero regressões nos testes automatizados.
- [ ] Stakeholder aprovou.

Assinatura: ********\_\_\_\_******** Data: ****\_\_****
