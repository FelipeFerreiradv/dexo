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

// Relógio FIXO de propósito. Com `new Date()` aqui, o teste
// "o Product devolvido é o MESMO com include vazio ou sem include" chama
// makeRow() duas vezes e compara os dois objetos com toEqual: quando as duas
// chamadas caíam em milissegundos diferentes, ele falhava sozinho
// (createdAt ...38.011Z vs ...38.012Z). O timestamp não é o que este spec mede.
const INSTANTE_FIXO = new Date("2026-01-01T00:00:00.000Z");

// Linha "raw" mínima que o mapPrismaToProduct consegue mapear (price.toNumber()).
function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    userId: "alice",
    sku: "SKU-1",
    name: "Pastilha de freio",
    stock: 1,
    price: { toNumber: () => 10 },
    createdAt: INSTANTE_FIXO,
    updatedAt: INSTANTE_FIXO,
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

// ──────────────────────────────────────────────────────────────────────────
// PERF: `include` de relação to-many é um SELECT SEPARADO no Prisma. Sem
// compatibilidades no payload ele volta sempre vazio — 1 round-trip por
// produto criado, e o "Importar anúncios" cria em série. O objeto devolvido
// não pode mudar: mapPrismaCompatibilities colapsa [] e undefined no mesmo
// undefined.
// ──────────────────────────────────────────────────────────────────────────
describe("ProductRepository.create — include condicional de compatibilities", () => {
  it("SEM compatibilidades: não pede include (evita o SELECT vazio)", async () => {
    mockProductCreate.mockResolvedValue(makeRow());

    await repo.create({ ...base });

    const arg = mockProductCreate.mock.calls[0][0];
    expect(arg.include).toBeUndefined();
    expect(arg.data.compatibilities).toBeUndefined();
  });

  it("COM compatibilidades: mantém o include verbatim", async () => {
    mockProductCreate.mockResolvedValue(
      makeRow({
        compatibilities: [
          {
            brand: "VW",
            model: "GOL",
            yearFrom: 2010,
            yearTo: null,
            version: null,
          },
        ],
      }),
    );

    const out = await repo.create({
      ...base,
      compatibilities: [{ brand: "VW", model: "GOL", yearFrom: 2010 }],
    } as never);

    const arg = mockProductCreate.mock.calls[0][0];
    expect(arg.include).toEqual({ compatibilities: true });
    expect(out.compatibilities).toEqual([
      {
        brand: "VW",
        model: "GOL",
        yearFrom: 2010,
        yearTo: null,
        version: null,
      },
    ]);
  });

  it("o Product devolvido é o MESMO com include vazio ou sem include", async () => {
    // Antes: a linha vinha com compatibilities: []. Agora: sem a chave.
    mockProductCreate.mockResolvedValue(makeRow({ compatibilities: [] }));
    const comArrayVazio = await repo.create({ ...base });

    vi.clearAllMocks();
    const semChave = makeRow();
    delete (semChave as Record<string, unknown>).compatibilities;
    mockProductCreate.mockResolvedValue(semChave);
    const semInclude = await repo.create({ ...base });

    expect(comArrayVazio.compatibilities).toBeUndefined();
    expect(semInclude.compatibilities).toBeUndefined();
    expect(semInclude).toEqual(comArrayVazio);
  });
});
