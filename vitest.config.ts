import { defineConfig } from "vitest/config";
import path from "path";

// Prisma valida a URL no construtor mesmo quando o teste mocka todas as queries.
// Sem isso, qualquer suite que importa um repository explode antes de rodar.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

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
