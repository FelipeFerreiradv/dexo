import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

// ──────────────────────────────────────────────────────────────────────────
// Tenant guard: ProductRepository.create valida posse do scrapId.
// Product.scrapId é FK p/ Scrap sem garantir Product.userId == Scrap.userId.
// Sem esta checagem, um payload forjado vincularia o produto à sucata de OUTRO
// tenant, poluindo getScrapParts/getScrapMoney/reconcile daquele lote.
// ──────────────────────────────────────────────────────────────────────────

const { mockProductCreate, mockScrapFindFirst } = vi.hoisted(() => ({
  mockProductCreate: vi.fn(),
  mockScrapFindFirst: vi.fn(),
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { create: mockProductCreate, findFirst: vi.fn() },
    scrap: { findFirst: mockScrapFindFirst },
    $transaction: vi.fn(),
  },
}));

const repo = new ProductRepositoryPrisma();

const base = {
  userId: "alice",
  sku: "SKU-1",
  name: "Pastilha de freio",
  stock: 1,
  price: 10,
} as any;

// Linha "raw" mínima que o mapPrismaToProduct consegue mapear (price.toNumber()).
function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    userId: "alice",
    sku: "SKU-1",
    name: "Pastilha de freio",
    stock: 1,
    price: { toNumber: () => 10 },
    createdAt: new Date(),
    updatedAt: new Date(),
    imageUrls: [],
    compatibilities: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProductRepository.create — tenant guard de scrapId", () => {
  it("rejeita scrapId de OUTRO tenant (sucata não pertence ao userId) e NÃO cria", async () => {
    mockScrapFindFirst.mockResolvedValue(null); // alice não é dona desta sucata

    await expect(
      repo.create({ ...base, scrapId: "bob-scrap" }),
    ).rejects.toThrow(/inválido/i);

    expect(mockScrapFindFirst).toHaveBeenCalledWith({
      where: { id: "bob-scrap", userId: "alice" },
      select: { id: true },
    });
    expect(mockProductCreate).not.toHaveBeenCalled();
  });

  it("aceita scrapId do PRÓPRIO tenant (sucata pertence ao userId)", async () => {
    mockScrapFindFirst.mockResolvedValue({ id: "alice-scrap" });
    mockProductCreate.mockResolvedValue(makeRow({ scrapId: "alice-scrap" }));

    const out = await repo.create({ ...base, scrapId: "alice-scrap" });

    expect(mockScrapFindFirst).toHaveBeenCalledTimes(1);
    expect(mockProductCreate).toHaveBeenCalledTimes(1);
    expect(out.id).toBe("p-1");
  });

  it("sem scrapId: NÃO consulta Scrap (no-op, fluxo inalterado)", async () => {
    mockProductCreate.mockResolvedValue(makeRow());

    await repo.create({ ...base });

    expect(mockScrapFindFirst).not.toHaveBeenCalled();
    expect(mockProductCreate).toHaveBeenCalledTimes(1);
  });
});
