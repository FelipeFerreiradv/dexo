import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Fase F — ScrapStatusReconcileService: transição automática best-effort de
// ScrapStatus a partir de uma venda balcão (pós-commit, idempotente).
//   - deriveScrapStatus: decision table pura.
//   - reconcileForReceivable: query A (sucatas efetivas) → por sucata, sob
//     advisory lock, query B (hasSales nos 2 canais + regCount + sumStock) e
//     UPDATE guardado (idempotente + ARCHIVED-safe).
//   - Best-effort: erro não estoura no chamador.
// ──────────────────────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => {
  const prisma: any = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return { default: prisma };
});

import prisma from "@/app/lib/prisma";
import {
  ScrapStatusReconcileService,
  deriveScrapStatus,
} from "../app/marketplaces/services/scrap-status-reconcile.service";

// Deixa os setImmediate (e seus awaits) drenarem.
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
  (prisma as any).$executeRaw.mockResolvedValue(1);
});

describe("deriveScrapStatus — decision table", () => {
  it("sem venda → AVAILABLE (qualquer estoque/contagem)", () => {
    expect(deriveScrapStatus(false, 0, 0)).toBe("AVAILABLE");
    expect(deriveScrapStatus(false, 5, 100)).toBe("AVAILABLE");
  });

  it("com venda, só-manual (regCount 0) → IN_USE (nunca DEPLETED)", () => {
    expect(deriveScrapStatus(true, 0, 0)).toBe("IN_USE");
  });

  it("com venda, peças cadastradas com estoque > 0 → IN_USE", () => {
    expect(deriveScrapStatus(true, 3, 7)).toBe("IN_USE");
  });

  it("com venda, peças cadastradas todas em estoque 0 → DEPLETED", () => {
    expect(deriveScrapStatus(true, 3, 0)).toBe("DEPLETED");
  });
});

describe("reconcileForReceivable — plumbing best-effort", () => {
  it("reconcilia a sucata efetiva: query A → tx (lock + query B + UPDATE guardado)", async () => {
    (prisma as any).$queryRaw
      .mockResolvedValueOnce([{ scrapId: "s-1" }]) // (A) sucatas efetivas
      .mockResolvedValueOnce([
        { hasSales: true, regCount: 2, sumStock: 0 }, // (B) fatos → DEPLETED
      ]);

    ScrapStatusReconcileService.reconcileForReceivable({
      receivableId: "r-1",
      userId: "user-owner",
    });
    await flush();

    // Uma tx por sucata efetiva.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    // 2 queries: (A) sucatas + (B) fatos.
    expect((prisma as any).$queryRaw).toHaveBeenCalledTimes(2);

    // (B) abrange OS DOIS canais + COALESCE (anti-duplicidade/override).
    const sqlB = JSON.stringify((prisma as any).$queryRaw.mock.calls[1][0]);
    expect(sqlB).toContain("OrderItem");
    expect(sqlB).toContain("MarketplaceAccount");
    expect(sqlB).toContain("ReceivableItem");
    expect(sqlB).toContain("COALESCE");

    // $executeRaw: advisory lock (tagged template, multi-arg) + UPDATE (Sql).
    const execCalls = (prisma as any).$executeRaw.mock.calls;
    expect(execCalls.length).toBe(2);
    // O lock referencia o namespace próprio 'scrap_status:'.
    const lockText = JSON.stringify(execCalls[0]);
    expect(lockText).toContain("pg_advisory_xact_lock");
    expect(lockText).toContain("scrap_status:");
    // O UPDATE é guardado: idempotente (status <> alvo) + ARCHIVED-safe + alvo.
    const updateText = JSON.stringify(execCalls[1][0]);
    expect(updateText).toContain("UPDATE");
    expect(updateText).toContain("ARCHIVED");
    expect(updateText).toContain("DEPLETED"); // alvo derivado (value)
  });

  it("nenhuma sucata efetiva (query A vazia) → não abre tx nem atualiza", async () => {
    (prisma as any).$queryRaw.mockResolvedValueOnce([]); // (A) vazio

    ScrapStatusReconcileService.reconcileForReceivable({
      receivableId: "r-1",
      userId: "user-owner",
    });
    await flush();

    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).$executeRaw).not.toHaveBeenCalled();
  });

  it("BEST-EFFORT: erro na query não estoura no chamador (retorno void)", async () => {
    (prisma as any).$queryRaw.mockRejectedValueOnce(new Error("db down"));

    // Não deve lançar de forma síncrona.
    expect(() =>
      ScrapStatusReconcileService.reconcileForReceivable({
        receivableId: "r-1",
        userId: "user-owner",
      }),
    ).not.toThrow();
    await flush();

    // Falhou na query A → nenhuma tx aberta. Sem rejeição não-tratada.
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });
});
