import { describe, it, expect, vi, afterEach } from "vitest";

// Stub do prisma client para evitar conexão real ao DB durante import.
vi.mock("@/app/lib/prisma", () => ({
  default: {},
}));

import { ListingUseCase as ListingUseCaseClass } from "../app/marketplaces/usecases/listing.usercase";

// Helpers privados acessados via cast — padrão de build-ml-attributes-oem.spec.ts.
const ListingUseCase: any = ListingUseCaseClass;

/**
 * LIGAÇÃO da conversão de OEM ao payload.
 *
 * O spec irmão (`ml-oem-tags.spec.ts`) cobre a função pura. Este cobre que ela
 * está de fato ligada nos dois pontos que montam `attributes`: o gate do
 * kill-switch e o `rebuildMLPayloadForCategory`, que remonta os atributos do
 * ZERO nos retries por categoria sugerida.
 */

const oemDe = (attrs: any[]) => attrs.find((a: any) => a.id === "OEM");

afterEach(() => {
  delete process.env.ML_OEM_TAGS_DISABLED;
});

describe("withOemAsTags — gate do kill-switch", () => {
  const entrada = () => [
    { id: "BRAND", value_name: "Volkswagen" },
    { id: "OEM", value_name: "farol, dianteiro, direito" },
  ];

  it("converte o OEM para lista por padrão", () => {
    const out = ListingUseCase.withOemAsTags(entrada());
    expect(oemDe(out)).toEqual({
      id: "OEM",
      values: [{ name: "farol" }, { name: "dianteiro" }, { name: "direito" }],
    });
  });

  it("KILL-SWITCH: ML_OEM_TAGS_DISABLED=1 devolve o array POR REFERÊNCIA", () => {
    process.env.ML_OEM_TAGS_DISABLED = "1";
    const original = entrada();
    const out = ListingUseCase.withOemAsTags(original);
    // Mesma referência = payload de hoje byte-a-byte, sem nem alocar array novo.
    expect(out).toBe(original);
    expect(oemDe(out).value_name).toBe("farol, dianteiro, direito");
  });

  it("não mexe nos demais atributos", () => {
    const out = ListingUseCase.withOemAsTags(entrada());
    expect(out.find((a: any) => a.id === "BRAND")).toEqual({
      id: "BRAND",
      value_name: "Volkswagen",
    });
  });
});

describe("rebuildMLPayloadForCategory — retry por categoria sugerida", () => {
  const produto = {
    sku: "SKU-OEM",
    name: "Cubo de roda dianteiro Gol",
    brand: "Volkswagen",
    model: "Gol",
    year: "2014",
    partNumber: "PN-INTERNO",
    attributes: { OEM: { value_name: "farol, dianteiro, direito" } },
  };

  const basePayload = {
    title: "Cubo de roda",
    category_id: "MLB111",
    price: 100,
    attributes: [
      { id: "SELLER_PACKAGE_WEIGHT", value_name: "1000" },
      { id: "OEM", value_name: "farol, dianteiro, direito" },
    ],
  } as any;

  it("o payload remontado leva o OEM em lista, não a string com vírgulas", () => {
    const out = ListingUseCase.rebuildMLPayloadForCategory(
      basePayload,
      produto,
      "MLB193419",
    );
    expect(oemDe(out.attributes)).toEqual({
      id: "OEM",
      values: [{ name: "farol" }, { name: "dianteiro" }, { name: "direito" }],
    });
  });

  it("preserva os SELLER_PACKAGE_* que vieram do payload original", () => {
    const out = ListingUseCase.rebuildMLPayloadForCategory(
      basePayload,
      produto,
      "MLB193419",
    );
    expect(
      out.attributes.find((a: any) => a.id === "SELLER_PACKAGE_WEIGHT"),
    ).toEqual({ id: "SELLER_PACKAGE_WEIGHT", value_name: "1000" });
  });

  it("com o kill-switch ligado, o retry volta a mandar a string única", () => {
    process.env.ML_OEM_TAGS_DISABLED = "1";
    const out = ListingUseCase.rebuildMLPayloadForCategory(
      basePayload,
      produto,
      "MLB193419",
    );
    expect(oemDe(out.attributes)).toEqual({
      id: "OEM",
      value_name: "farol, dianteiro, direito",
    });
  });

  it("um código só continua singular no retry", () => {
    const out = ListingUseCase.rebuildMLPayloadForCategory(
      basePayload,
      { ...produto, attributes: { OEM: { value_name: "5U0121049" } } },
      "MLB193419",
    );
    expect(oemDe(out.attributes)).toEqual({
      id: "OEM",
      value_name: "5U0121049",
    });
  });

  it("PART_NUMBER continua vindo do campo fixo, intocado", () => {
    const out = ListingUseCase.rebuildMLPayloadForCategory(
      basePayload,
      produto,
      "MLB193419",
    );
    expect(
      out.attributes.find((a: any) => a.id === "PART_NUMBER"),
    ).toEqual({ id: "PART_NUMBER", value_name: "PN-INTERNO" });
  });
});
