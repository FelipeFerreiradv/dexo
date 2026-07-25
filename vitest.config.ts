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
