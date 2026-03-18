import { afterEach, describe, expect, it, vi } from "vitest";

// Access private helpers via any-cast – acceptable for focused unit tests
import { ListingUseCase as ListingUseCaseClass } from "../listing.usercase";
import { CategoryResolutionService } from "../../services/category-resolution.service";
import CategoryRepository from "../../repositories/category.repository";

const ListingUseCase: any = ListingUseCaseClass;

describe("ML family_name policy", () => {
  it("treats MLB193531 as requiring family_name and no title", () => {
    expect(ListingUseCase.shouldIncludeFamilyName("MLB193531")).toBe(true);
    expect(ListingUseCase.noTitleWithFamilyName("MLB193531")).toBe(true);
  });

  it("keeps accented characters when sanitizing title from IBR", () => {
    const product = { name: "Reservatório do Pára-brisa" };
    const title = ListingUseCase.sanitizeTitle(product.name, product, 60);
    expect(title).toBe("Reservatório do Pára-brisa");
  });

  it("preserves family_name when dropping title for catalog flow", () => {
    const product = { name: "Kit Teste", brand: "ACME", sku: "SKU-1" };
    const familyName =
      ListingUseCase.normalizeUtf8(product.brand) ||
      ListingUseCase.normalizeUtf8(product.name);

    const basePayload: any = {
      title: "Kit Teste",
      category_id: "MLB193531",
      price: 10,
      currency_id: "BRL",
      available_quantity: 1,
      buying_mode: "buy_it_now",
      listing_type_id: "bronze",
      condition: "used",
      pictures: [],
      attributes: [],
    };

    if (ListingUseCase.shouldIncludeFamilyName("MLB193531") && familyName) {
      basePayload.family_name = familyName;
      delete basePayload.title;
    }

    expect(basePayload.family_name).toBe("ACME");
    expect(basePayload.title).toBeUndefined();
  });
});

describe("Category fallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to 'Outros' leaf when parent category is provided", async () => {
    vi.spyOn(CategoryRepository, "listWithParents").mockResolvedValue([
      {
        externalId: "MLB123",
        name: "Peças",
        fullPath: "Peças",
        parentExternalId: null,
        siteId: "MLB",
      } as any,
      {
        externalId: "MLB123-OTR",
        name: "Outros",
        fullPath: "Peças > Outros",
        parentExternalId: "MLB123",
        siteId: "MLB",
      } as any,
    ]);

    const leaf = await CategoryResolutionService.ensureLeafLocalOnly("MLB123");
    expect(leaf?.externalId).toBe("MLB123-OTR");
  });
});

