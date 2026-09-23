import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ProductUseCase.update × anúncios do ML recusados por dado.
 *
 * A revisão de 23/09/2026 apontou que só a lógica pura (ml-rearm.logic) e o
 * repositório tinham teste — a LIGAÇÃO no update não. Estes testes travam:
 * edição que pode mudar o resultado re-arma; edição só de estoque não; troca
 * de categoria do ML limpa a categoria da tentativa recusada; falha no
 * re-arme não derruba a edição.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    rearmCorrectableMlPlaceholders: vi.fn(async () => 0),
    clearRequestedCategoryForMlPlaceholders: vi.fn(async () => 0),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: { stockLog: { create: vi.fn(async () => ({})) } },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn(), logWarning: vi.fn(), log: vi.fn() },
}));

import { ProductUseCase } from "../app/usecases/product.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { REARM_DELAY_MS } from "../app/marketplaces/lib/ml-rearm.logic";

const ANTES = {
  id: "p1",
  name: "Farol Gol G5",
  description: "Farol esquerdo",
  price: { toNumber: () => 300 },
  stock: 2,
  brand: "VW",
  model: "Gol",
  year: "2010",
  mlCategoryId: "MLB1",
  mlCategory: "Faróis",
  heightCm: 20,
  widthCm: 30,
  lengthCm: 40,
  weightKg: 2,
  imageUrl: "/uploads/a.jpg",
  imageUrls: [],
  attributes: { GTIN: { value_name: "2033029" } },
};

function useCase() {
  const uc = new ProductUseCase(null);
  (uc as any).productRepository = {
    findById: vi.fn(async () => ({ ...ANTES })),
    update: vi.fn(async (_id: string, data: any) => ({ ...ANTES, ...data })),
  };
  vi.spyOn(uc as any, "clearOverridesForEditedFields").mockResolvedValue(undefined);
  vi.spyOn(uc as any, "syncProductListings").mockResolvedValue([]);
  return uc;
}

const rearm = ListingRepository.rearmCorrectableMlPlaceholders as ReturnType<typeof vi.fn>;
const limpar = ListingRepository.clearRequestedCategoryForMlPlaceholders as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});

describe("ProductUseCase.update → re-arme dos anúncios do ML corrigíveis", () => {
  it("corrigiu a ficha técnica ⇒ re-arma os pendentes do produto, sem mexer na categoria", async () => {
    await useCase().update("p1", { attributes: { GTIN: { value_name: "" } } } as any, "u1");
    expect(rearm).toHaveBeenCalledTimes(1);
    const [id, atraso, agora, opts] = rearm.mock.calls[0];
    expect(id).toBe("p1");
    expect(atraso).toBe(REARM_DELAY_MS);
    expect(agora).toBeInstanceOf(Date);
    expect(opts).toEqual({});
    expect(limpar).not.toHaveBeenCalled();
  });

  it("mudou só o estoque ⇒ NÃO re-arma (a recusa seria a mesma)", async () => {
    await useCase().update("p1", { stock: 5 } as any, "u1");
    expect(rearm).not.toHaveBeenCalled();
    expect(limpar).not.toHaveBeenCalled();
  });

  it("salvamento sem mudança real (listas vazias do modal) ⇒ NÃO re-arma", async () => {
    await useCase().update(
      "p1",
      { stock: 2, compatibilities: [], compatibilityPositions: {} } as any,
      "u1",
    );
    expect(rearm).not.toHaveBeenCalled();
  });

  it("trocou a categoria do ML ⇒ limpa a categoria da tentativa recusada e re-arma sem ela", async () => {
    await useCase().update("p1", { mlCategoryId: "MLB2" } as any, "u1");
    expect(limpar).toHaveBeenCalledWith("p1");
    expect(rearm.mock.calls[0][3]).toEqual({ clearRequestedCategory: true });
  });

  it("re-arme falhou ⇒ a edição do produto continua valendo (best-effort)", async () => {
    rearm.mockRejectedValueOnce(new Error("pool esgotado"));
    const r = await useCase().update("p1", { name: "Farol Gol G5 esquerdo" } as any, "u1");
    expect(r.product.name).toBe("Farol Gol G5 esquerdo");
  });
});
