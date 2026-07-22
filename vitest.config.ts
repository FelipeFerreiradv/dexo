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
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
