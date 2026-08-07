-- Bloco F — peça avulsa cadastrada na venda dá entrada E saída no estoque.
--
-- Hoje o item manual (ReceivableItem.productId = NULL) entra na sucata em
-- DINHEIRO (getScrapMoney usa COALESCE(ri.scrapId, p.scrapId)) mas NÃO entra em
-- QUANTIDADE (getScrapParts agrupa por productId, e null nunca casa). Estas 3
-- colunas sustentam a promoção do item a produto real do catálogo.
--
-- TODAS com DEFAULT FALSE — e é esse default que garante a RETROATIVIDADE:
-- cada linha já existente nasce `false`, então ligar a flag da aplicação NÃO
-- altera nada do histórico. "Deixar como estão" fica garantido pelo BANCO, não
-- por disciplina de código.
--
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
--
-- ORDEM DE DEPLOY: DDL -> prisma generate -> deploy do código -> flag ON.

-- Opt-in do operador ("criar no catálogo", checkbox na linha do item manual).
ALTER TABLE "ReceivableItem"
  ADD COLUMN IF NOT EXISTS "createCatalogProduct" BOOLEAN NOT NULL DEFAULT false;

-- Marca que o `productId` deste item foi criado automaticamente a partir dele.
-- É a âncora do estorno simétrico: só nestes itens o estorno faz a saída
-- compensatória, para o produto voltar a estoque 0 em vez de virar fantasma.
ALTER TABLE "ReceivableItem"
  ADD COLUMN IF NOT EXISTS "autoCreatedProduct" BOOLEAN NOT NULL DEFAULT false;

-- Produto que nasceu de peça avulsa. Excluído da contagem de catálogo na
-- reconciliação de status da sucata (ScrapStatusReconcileService): sem isto,
-- uma sucata vendida só no balcão (regCount 0, IN_USE) passaria a DEPLETED ao
-- ganhar o primeiro produto com estoque 0. Como a coluna é false em 100% das
-- linhas existentes, o status de toda sucata em produção fica inalterado.
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "autoCreatedFromSale" BOOLEAN NOT NULL DEFAULT false;
