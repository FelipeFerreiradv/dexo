import { defineConfig } from "vitest/config";
import path from "path";

// Prisma valida a URL no construtor mesmo quando o teste mocka todas as queries.
// Sem isso, qualquer suite que importa um repository explode antes de rodar.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

// Auto-cadastro de cliente no import de pedidos: desligado por default na
// suíte para os specs existentes de import (Shopee/Magalu/ML) continuarem
// byte-idênticos — sem o kill-switch, o hook novo tentaria API real + prisma
// dummy dentro deles. O spec da feature (order-auto-customer) reabilita
// explicitamente por caso.
process.env.ORDER_AUTO_CUSTOMER_DISABLED ??= "1";

// Espelhamento de status marketplace→Dexo: desligado por default na suíte
// para os specs existentes (webhook de item / stock sync) continuarem
// byte-idênticos. Os specs da feature reabilitam explicitamente por caso.
process.env.LISTING_STATUS_SYNC_DISABLED ??= "1";

// Janela do poll Shopee por `update_time` + marca d'água + lista de exclusão
// de status: desligados por default na suíte para os specs de import
// existentes continuarem byte-idênticos (o caminho novo grava a marca d'água
// em MarketplaceAccount, que eles não mockam). O spec da feature
// (shopee-order-import-status-window) reabilita explicitamente por caso.
process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED ??= "1";

// Busca dirigida pelo `order_sn` do push Shopee: desligada por default na
// suíte, senão os specs que afirmam a assinatura exata do re-poll
// (webhook-cancellation) veriam o 4o argumento novo. O spec da feature
// (webhook-shopee-targeted-ingestion) reabilita explicitamente por caso.
process.env.SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED ??= "1";

// Marca de auditoria Order.stockDeductedAt (gravada dentro da transação da
// baixa): desligada por default na suíte porque os specs de estoque montam um
// `tx` mockado à mão (buildMockTx) que só tem os delegates que o caminho
// anterior usava. O spec da feature (order-stock-deduction-guarantee)
// reabilita explicitamente por caso.
process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED ??= "1";

// Net-dentro-da-transação na RE-TENTATIVA de baixa (auditoria 29/07/2026):
// desligado por default na suíte porque os specs existentes de
// `retryStockDeduction` afirmam o caminho ANTERIOR (net lido fora da transação,
// `deductStockForOrder` recebendo a lista já filtrada). Em produção o default é
// o oposto — ligado —, porque o caminho antigo pode baixar duas vezes. O spec da
// correção (order-stock-retry-race) reabilita explicitamente por caso.
process.env.ORDER_STOCK_RETRY_TX_NET_DISABLED ??= "1";

// Quarentena de ingestão para ML e Magalu (auditoria 29/07/2026): desligada por
// default na suíte porque os specs de import de ML e Magalu não mockam a tabela
// nova, e o registro é best-effort (o erro é engolido, mas gera ruído). Em
// produção o default é o oposto — ligado —, senão o invariante "nenhum descarte
// silencioso" valeria para um marketplace de três. O spec da correção
// (order-ingestion-ml-magalu) reabilita explicitamente por caso.
process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED ??= "1";

// Data da venda (Order.soldAt) e o filtro por COALESCE(soldAt, createdAt):
// desligados por default na suíte porque `order-repository-list` afirma o
// mapeamento ANTERIOR ("dateFrom/dateTo mapeiam createdAt { gte, lte }"), que é
// exatamente o que muda. Em produção o default é o oposto — ligado —, senão o
// faturamento continua datado pela hora do import. O spec da correção
// (order-sold-at-and-unlinked-order) reabilita explicitamente por caso.
process.env.ORDER_SOLD_AT_DISABLED ??= "1";

// Transicao para NEEDS_ACTION quando a pendencia esgota as tentativas: desligada
// por default na suite porque `order-ingestion-reconciler` afirma o comportamento
// ANTERIOR ("apos N tentativas escala o SystemLog mas NAO fecha a pendencia",
// esperando status OPEN). Em producao o default e o oposto — ligado —, senao 89
// pendencias irresolviveis seguem batendo na API da Shopee para sempre. O spec da
// correcao (order-ingestion-needs-action) reabilita explicitamente por caso.
process.env.ORDER_INGESTION_NEEDS_ACTION_DISABLED ??= "1";

// Completar pedido que existe com ZERO itens (31/07/2026): desligado por default
// na suite porque acrescenta uma consulta `order.findMany` no inicio do laco de
// import, e os specs pre-existentes mockam `prisma.order.findMany` com UMA
// implementacao — a consulta nova receberia a lista de pedidos existentes e
// interpretaria todos como vazios. Em producao o default e o oposto — ligado —,
// senao o pedido de zero itens nunca mais e revisitado (84 pedidos do ML,
// R$ 27.731,47, presos assim). O spec da correcao
// (order-completar-pedido-vazio) reabilita explicitamente por caso.
process.env.ORDER_COMPLETE_EMPTY_ORDER_DISABLED ??= "1";

// Recorte "Order sem itens so na Shopee" (31/07/2026): MANTIDO por default na
// suite porque `order-sold-at-and-unlinked-order` afirma que ML e Magalu NAO
// criam o Order vazio, que era o estado correto enquanto nao havia caminho de
// completar. Em producao o default e o oposto — as tres plataformas criam —,
// porque a outra metade do par agora existe. O spec da correcao reabilita
// explicitamente por caso.
process.env.ORDER_CREATE_WITHOUT_ITEMS_ML_MAGALU_DISABLED ??= "1";

// Resiliência do módulo de etiqueta (incidente Shopee 29/07/2026): lock por
// pedido, retry de transitório, orçamento de tempo, pré-checagem do XML e
// consulta do get_shipping_document_parameter. TODOS desligados por default na
// suíte para os specs existentes continuarem byte-idênticos — eles mockam o
// conjunto exato de chamadas do caminho anterior e afirmam "uma chamada, um
// erro propagado". Em produção o default é o oposto — ligados —, senão dois
// cliques duplicam ship_order e um 5xx passageiro vira falha definitiva. Os
// specs da correção reabilitam explicitamente por caso.
process.env.SHIPPING_LABEL_LOCK_DISABLED ??= "1";
process.env.SHIPPING_LABEL_RETRY_DISABLED ??= "1";
process.env.SHIPPING_LABEL_TIME_BUDGET_DISABLED ??= "1";
process.env.SHIPPING_LABEL_PRECHECKS_DISABLED ??= "1";
process.env.SHOPEE_LABEL_DOC_PARAM_DISABLED ??= "1";

// Tolerância ao "upload não aceito após o envio arranjado" da Shopee: também
// desligada por default na suíte, porque muda `ensureInvoiceSent` de "propaga o
// erro" para "segue em frente". Em produção o default é o oposto — ligada —,
// senão o pedido cujo envio já foi arranjado nunca mais consegue etiqueta.
process.env.SHOPEE_INVOICE_ARRANGED_TOLERANT_DISABLED ??= "1";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Os defaults do vitest são 5s por teste e 10s por hook. Vários specs
    // pré-existentes que sobem servidor/fila rodam em ~4,0-4,1s de wall-clock,
    // ou seja com menos de 1s de folga. A suíte roda com um worker por core, e
    // em máquina carregada qualquer um deles cruza os 5s e falha por timeout
    // sem que nada tenha regredido — era a origem das falhas intermitentes que
    // nunca reproduziam quando o arquivo era re-executado isolado.
    //
    // Elevar o teto é mudança puramente permissiva: nenhum teste que passa hoje
    // passa a falhar. Os specs que precisam de um limite próprio continuam
    // passando o timeout no 2o argumento do `it()`, que tem precedência sobre
    // este default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
