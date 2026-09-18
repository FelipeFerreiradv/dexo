import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
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
    importNewShopeeItemsForAccount: vi.fn(),
    importNewMagaluItemsForAccount: vi.fn(),
    importNewFacebookItemsForAccount: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/usecases/messages.usecase", () => ({
  MessagesUseCase: {
    syncShopeeCommentsForAccount: vi.fn(),
    syncMagaluMessagesForAccount: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../scripts/sync-listing-metrics", () => ({
  syncAllListingsMetrics: vi.fn().mockResolvedValue(undefined),
}));

import prisma from "../app/lib/prisma";
import { __testing } from "../scripts/sync-orders-and-metrics-loop";

type Signal = "SIGTERM" | "SIGINT";

function fakeSignalTarget() {
  const listeners = new Map<Signal, () => void>();
  const target = {
    exitCode: undefined as number | string | undefined,
    exit: vi.fn(),
    on(signal: Signal, listener: () => void) {
      listeners.set(signal, listener);
      return target;
    },
    off(signal: Signal, listener: () => void) {
      if (listeners.get(signal) === listener) listeners.delete(signal);
      return target;
    },
  };
  return { target, listeners };
}

const originalWorkerEnabled = process.env.BACKGROUND_WORKERS_ENABLED;
const originalWorkerDisabled = process.env.BACKGROUND_WORKERS_DISABLED;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalWorkerEnabled === undefined) {
    delete process.env.BACKGROUND_WORKERS_ENABLED;
  } else {
    process.env.BACKGROUND_WORKERS_ENABLED = originalWorkerEnabled;
  }
  if (originalWorkerDisabled === undefined) {
    delete process.env.BACKGROUND_WORKERS_DISABLED;
  } else {
    process.env.BACKGROUND_WORKERS_DISABLED = originalWorkerDisabled;
  }
  vi.restoreAllMocks();
});

describe("encerramento cooperativo do dexo-sync-orders", () => {
  it("cancela imediatamente o wait e é idempotente", async () => {
    const shutdown = __testing.createShutdownController();
    const waiting = shutdown.wait(60_000);

    expect(shutdown.requestStop("SIGTERM")).toBe(true);
    expect(shutdown.requestStop("SIGINT")).toBe(false);

    await expect(waiting).resolves.toBe(false);
    await expect(shutdown.wait(60_000)).resolves.toBe(false);
  });

  it("SIGTERM e SIGINT pedem parada sem chamar process.exit", async () => {
    const shutdown = __testing.createShutdownController();
    const { target, listeners } = fakeSignalTarget();
    const remove = __testing.installShutdownHandlers(shutdown, target);
    const waiting = shutdown.wait(60_000);

    listeners.get("SIGTERM")!();
    listeners.get("SIGINT")!();

    expect(target.exitCode).toBe(0);
    expect(shutdown.isStopping()).toBe(true);
    expect(target.exit).not.toHaveBeenCalled();
    await expect(waiting).resolves.toBe(false);

    remove();
    expect(listeners.size).toBe(0);
  });

  it("não interrompe uma passada separada em voo e não inicia outra", async () => {
    const shutdown = __testing.createShutdownController();
    let finishPass!: (value: { accounts: number; elapsedMs: number }) => void;
    const pass = vi.fn(
      () =>
        new Promise<{ accounts: number; elapsedMs: number }>((resolve) => {
          finishPass = resolve;
        }),
    );

    let finished = false;
    const loop = __testing.runLoop("orders", 1, pass, shutdown).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(1));

    shutdown.requestStop("SIGTERM");
    await Promise.resolve();
    expect(finished).toBe(false);

    finishPass({ accounts: 1, elapsedMs: 10 });
    await loop;

    expect(finished).toBe(true);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it("faz o mesmo no modo legado e desconecta após a passada atual", async () => {
    const shutdown = __testing.createShutdownController();
    let finishCycle!: () => void;
    const cycle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCycle = resolve;
        }),
    );

    let finished = false;
    const loop = __testing.runLegacyLoop(shutdown, cycle).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(1));

    shutdown.requestStop("SIGINT");
    await Promise.resolve();
    expect(finished).toBe(false);

    finishCycle();
    await loop;

    expect(cycle).toHaveBeenCalledTimes(1);
    expect((prisma as any).$disconnect).toHaveBeenCalledTimes(1);
  });

  it("main aguarda os dois loops, desconecta e remove os handlers", async () => {
    process.env.BACKGROUND_WORKERS_ENABLED = "1";
    delete process.env.BACKGROUND_WORKERS_DISABLED;
    const { target, listeners } = fakeSignalTarget();

    const running = __testing.main(target);
    await vi.waitFor(() => expect(listeners.has("SIGTERM")).toBe(true));

    listeners.get("SIGTERM")!();
    await running;

    expect(target.exitCode).toBe(0);
    expect((prisma as any).$disconnect).toHaveBeenCalledTimes(1);
    expect(target.exit).toHaveBeenCalledWith(0);
    expect(
      vi.mocked((prisma as any).$disconnect).mock.invocationCallOrder[0],
    ).toBeLessThan(target.exit.mock.invocationCallOrder[0]);
    expect(listeners.size).toBe(0);
  });
});
