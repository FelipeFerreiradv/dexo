import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Auditoria adversarial de 29/07/2026 — dois achados sobre o loop de sync.
//
// 1. (crítico de completude) SYNC_LOOP_SPLIT_DISABLED não era exercitado por
//    teste algum: o spec que leva o nome da cadência chamava `runOnce` direto e
//    nunca setava a variável. Ou seja, o botão de REVERTER a mudança de cadência
//    — a mudança mais arriscada do trabalho — não tinha prova de funcionar.
//
// 2. O loop era o único entrypoint do projeto que NÃO carregava o .env. Isso
//    tornava TODOS os kill-switches inoperantes nesse processo, porque
//    `pm2 restart` reaproveita o ambiente gravado no dump e `--update-env` é
//    proibido aqui (incidente de 23/07). A doc do ecosystem.config.cjs já
//    afirmava que "os scripts importam dotenv/config"; este não importava.
//
// Estes testes precisam de `resetModules` + import dinâmico porque as duas
// coisas são resolvidas na CARGA do módulo — que é justamente o que as tornava
// difíceis de testar e fáceis de errar.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn(), findUnique: vi.fn() },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: {
    importRecentOrdersForAccount: vi.fn().mockResolvedValue(undefined),
    importRecentShopeeOrdersForAccount: vi.fn().mockResolvedValue(undefined),
    importRecentMagaluOrdersForAccount: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../app/marketplaces/usecases/sync.usercase", () => ({
  SyncUseCase: {
    importNewShopeeItemsForAccount: vi
      .fn()
      .mockResolvedValue({ created: 0, linked: 0, skipped: 0, errors: 0 }),
    importNewMagaluItemsForAccount: vi
      .fn()
      .mockResolvedValue({ created: 0, linked: 0, skipped: 0, errors: 0 }),
  },
}));

vi.mock("../app/marketplaces/usecases/messages.usecase", () => ({
  MessagesUseCase: {
    syncShopeeCommentsForAccount: vi
      .fn()
      .mockResolvedValue({ comments: 0, errors: 0 }),
    syncMagaluMessagesForAccount: vi
      .fn()
      .mockResolvedValue({ conversations: 0, errors: 0 }),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logInfo: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../scripts/sync-listing-metrics", () => ({
  syncAllListingsMetrics: vi.fn().mockResolvedValue(undefined),
}));

const CAMINHO = "../scripts/sync-orders-and-metrics-loop";

/** Carrega o módulo do zero com o ambiente atual. */
async function carregar() {
  vi.resetModules();
  return (await import(CAMINHO)) as any;
}

const guardadas: Record<string, string | undefined> = {};
const NOMES = [
  "SYNC_LOOP_SPLIT_DISABLED",
  "SYNC_FULL_INTERVAL_MINUTES",
  "SYNC_ORDERS_CONCURRENCY",
  "SYNC_LOOP_DAYS",
  "SYNC_CATALOG_INTERVAL_MINUTES",
];

beforeEach(() => {
  for (const n of NOMES) {
    guardadas[n] = process.env[n];
    delete process.env[n];
  }
});

afterEach(() => {
  for (const n of NOMES) {
    if (guardadas[n] === undefined) delete process.env[n];
    else process.env[n] = guardadas[n]!;
  }
  vi.resetModules();
});

describe("SYNC_LOOP_SPLIT_DISABLED escolhe o modo do loop", () => {
  it('ausente => modo "separado" (pedidos e catálogo em cadências próprias)', async () => {
    const { __testing } = await carregar();
    expect(__testing.modoDoLoop()).toBe("separado");
  });

  it('"1" => modo "legado" (ciclo único serial de antes)', async () => {
    process.env.SYNC_LOOP_SPLIT_DISABLED = "1";
    const { __testing } = await carregar();
    expect(__testing.modoDoLoop()).toBe("legado");
  });

  it('vazio NÃO liga o kill-switch (só o literal "1")', async () => {
    process.env.SYNC_LOOP_SPLIT_DISABLED = "";
    const { __testing } = await carregar();
    expect(__testing.modoDoLoop()).toBe("separado");
  });

  it('"true" NÃO liga o kill-switch — o padrão do projeto é o literal "1"', async () => {
    process.env.SYNC_LOOP_SPLIT_DISABLED = "true";
    const { __testing } = await carregar();
    expect(__testing.modoDoLoop()).toBe("separado");
  });
});

describe("envInt — leitura de env à prova de NaN", () => {
  it("ausente devolve o default", async () => {
    const { __testing } = await carregar();
    expect(__testing.envInt("NAO_EXISTE_MESMO", 15, 1)).toBe(15);
  });

  it("string vazia devolve o default", async () => {
    process.env.SYNC_ORDERS_CONCURRENCY = "";
    const { __testing } = await carregar();
    expect(__testing.envInt("SYNC_ORDERS_CONCURRENCY", 4, 1)).toBe(4);
  });

  it("texto devolve o default, NÃO NaN", async () => {
    process.env.SYNC_ORDERS_CONCURRENCY = "abc";
    const { __testing } = await carregar();
    const v = __testing.envInt("SYNC_ORDERS_CONCURRENCY", 4, 1);
    // `Math.max(1, parseInt("abc"))` devolve NaN. Com NaN, o runPool criava ZERO
    // workers: nenhum pedido importado, sem erro nenhum.
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBe(4);
  });

  it("valor abaixo do piso é elevado ao piso", async () => {
    process.env.SYNC_ORDERS_CONCURRENCY = "0";
    const { __testing } = await carregar();
    expect(__testing.envInt("SYNC_ORDERS_CONCURRENCY", 4, 1)).toBe(1);
  });

  it("negativo é elevado ao piso", async () => {
    process.env.SYNC_FULL_INTERVAL_MINUTES = "-30";
    const { __testing } = await carregar();
    expect(__testing.envInt("SYNC_FULL_INTERVAL_MINUTES", 15, 1)).toBe(1);
  });

  it("valor válido é respeitado", async () => {
    process.env.SYNC_ORDERS_CONCURRENCY = "8";
    const { __testing } = await carregar();
    expect(__testing.envInt("SYNC_ORDERS_CONCURRENCY", 4, 1)).toBe(8);
  });
});

describe("o módulo carrega o .env", () => {
  it("importa dotenv/config antes do prisma", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const arquivo = path.resolve(
      __dirname,
      "../scripts/sync-orders-and-metrics-loop.ts",
    );
    const fonte = fs.readFileSync(arquivo, "utf8");

    const iDotenv = fonte.indexOf('import "dotenv/config"');
    const iPrisma = fonte.indexOf('from "../app/lib/prisma"');

    // Sem isto, variável NOVA no .env nunca chega ao processo dexo-sync-orders
    // num `pm2 restart` — e `--update-env` é proibido neste projeto.
    expect(iDotenv).toBeGreaterThanOrEqual(0);
    expect(iPrisma).toBeGreaterThan(iDotenv);
  });
});
