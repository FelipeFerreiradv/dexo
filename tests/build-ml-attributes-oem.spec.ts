import { describe, it, expect, vi, afterEach } from "vitest";

// Stub do prisma client para evitar conexão real ao DB durante import.
vi.mock("@/app/lib/prisma", () => ({
  default: {},
}));

import { ListingUseCase as ListingUseCaseClass } from "../app/marketplaces/usecases/listing.usercase";

// Helpers privados acessados via cast — padrão de build-ml-attributes-position.spec.ts.
const ListingUseCase: any = ListingUseCaseClass;

// Categoria de autopeça. Levantado na API real: as 38 categorias de autopeça
// verificadas expõem OEM (string, max 255, nunca required/hidden) e
// PART_NUMBER (required). Fora de autopeça, OEM não existe.
const CATEGORIA = "MLB193419";

const attr = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  valueType: "string",
  required: false,
  variationRequired: false,
  ...extra,
});

const COM_OEM = [
  attr("PART_NUMBER", { required: true }),
  attr("OEM"),
  attr("MPN", { hidden: true }),
  attr("MATERIAL"),
];

const SEM_OEM = [
  attr("PART_NUMBER", { required: true }),
  attr("MPN", { hidden: true }),
  attr("MATERIAL"),
];

const baseProduct = {
  sku: "SKU-OEM",
  name: "Cubo de roda dianteiro Gol",
  brand: "Volkswagen",
  model: "Gol",
  year: "2014",
  partNumber: "PN-INTERNO",
};

const byId = (out: any[]) =>
  new Map<string, any>(out.map((a: any) => [a.id, a]));
const oemOf = (out: any[]) => out.filter((a: any) => a.id === "OEM");

afterEach(() => {
  delete process.env.ML_OEM_ATTR_DISABLED;
});

describe("buildMLAttributes — código OEM", () => {
  it("categoria que expõe OEM: o valor do operador entra no payload", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    const oem = oemOf(out);
    expect(oem).toHaveLength(1);
    expect(oem[0].value_name).toBe("5U0121049");
    // Sem value_id: OEM é texto livre, nunca lista fechada.
    expect(oem[0].value_id).toBeUndefined();
  });

  it("categoria que NÃO expõe OEM: o atributo é removido do payload", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, SEM_OEM);
    expect(oemOf(out)).toHaveLength(0);
  });

  it("remover o OEM não leva junto nenhum outro atributo", () => {
    const product = {
      ...baseProduct,
      attributes: {
        OEM: { value_name: "5U0121049" },
        MATERIAL: { value_name: "Aço" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, SEM_OEM);
    const m = byId(out);
    expect(m.has("OEM")).toBe(false);
    expect(m.get("MATERIAL")?.value_name).toBe("Aço");
    expect(m.get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
    expect(m.get("SELLER_SKU")?.value_name).toBe("SKU-OEM");
    expect(m.get("BRAND")?.value_name).toBe("Volkswagen");
  });

  it("SEM categoryAttrs (fallback legado): payload inalterado, nada é removido", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA);
    // A guarda não age no escuro: o merge já mandava o OEM e continua mandando.
    expect(oemOf(out)).toHaveLength(1);
    expect(oemOf(out)[0].value_name).toBe("5U0121049");
  });

  it("categoryAttrs vazio também conta como ausente (não remove nada)", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, []);
    expect(oemOf(out)).toHaveLength(1);
  });

  it("KILL-SWITCH: ML_OEM_ATTR_DISABLED=1 restaura o pass-through", () => {
    process.env.ML_OEM_ATTR_DISABLED = "1";
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, SEM_OEM);
    expect(oemOf(out)).toHaveLength(1);
    expect(oemOf(out)[0].value_name).toBe("5U0121049");
  });

  it("OEM vazio: payload idêntico ao de um produto sem o campo", () => {
    const comVazio = ListingUseCase.buildMLAttributes(
      { ...baseProduct, attributes: { OEM: { value_name: "   " } } },
      CATEGORIA,
      COM_OEM,
    );
    const semCampo = ListingUseCase.buildMLAttributes(
      { ...baseProduct },
      CATEGORIA,
      COM_OEM,
    );
    expect(comVazio).toEqual(semCampo);
    expect(oemOf(comVazio)).toHaveLength(0);
  });

  it("produto sem OEM nenhum: mesma saída com e sem a guarda", () => {
    const semGuarda = (() => {
      process.env.ML_OEM_ATTR_DISABLED = "1";
      const r = ListingUseCase.buildMLAttributes(
        { ...baseProduct },
        CATEGORIA,
        SEM_OEM,
      );
      delete process.env.ML_OEM_ATTR_DISABLED;
      return r;
    })();
    const comGuarda = ListingUseCase.buildMLAttributes(
      { ...baseProduct },
      CATEGORIA,
      SEM_OEM,
    );
    expect(comGuarda).toEqual(semGuarda);
  });
});

describe("buildMLAttributes — PART_NUMBER não muda de fonte", () => {
  it("PART_NUMBER continua vindo de product.partNumber, não do OEM", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "OEM-999" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    expect(byId(out).get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
  });

  it("sem partNumber, o OEM NÃO preenche PART_NUMBER", () => {
    const product = {
      ...baseProduct,
      partNumber: undefined,
      attributes: { OEM: { value_name: "OEM-999" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    expect(byId(out).has("PART_NUMBER")).toBe(false);
    expect(oemOf(out)[0].value_name).toBe("OEM-999");
  });

  it("OEM não sobrescreve PART_NUMBER nem quando informado sob esse id", () => {
    const product = {
      ...baseProduct,
      attributes: {
        PART_NUMBER: { value_name: "TENTATIVA" },
        OEM: { value_name: "OEM-999" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    expect(byId(out).get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
  });
});

// A Revisão individual do anúncio em massa não grava em Product: o mapa da
// ficha vai como override por produto. O update pós-criação descarta `OEM`
// (IMMUTABLE_ATTRS), então o create é o único caminho possível para ele.
describe("withOemFromOverride — OEM da Revisão individual", () => {
  const chamar = (product: any, override: any) =>
    ListingUseCase.withOemFromOverride(product, override);

  it("traz o OEM do override quando o produto não tem nenhum", () => {
    const out = chamar({ ...baseProduct, attributes: {} }, {
      OEM: { value_name: "5U0121049" },
    });
    expect((out.attributes as any).OEM.value_name).toBe("5U0121049");
  });

  it("chega ao payload do ML pelo buildMLAttributes", () => {
    const efetivo = chamar({ ...baseProduct }, { OEM: { value_name: "OEM-77" } });
    const out = ListingUseCase.buildMLAttributes(efetivo, CATEGORIA, COM_OEM);
    expect(oemOf(out)[0].value_name).toBe("OEM-77");
  });

  it("o produto VENCE: override não sobrescreve OEM já cadastrado", () => {
    const out = chamar(
      { ...baseProduct, attributes: { OEM: { value_name: "DO-PRODUTO" } } },
      { OEM: { value_name: "DO-OVERRIDE" } },
    );
    expect((out.attributes as any).OEM.value_name).toBe("DO-PRODUTO");
  });

  it("OEM em branco no produto não bloqueia o override", () => {
    const out = chamar(
      { ...baseProduct, attributes: { OEM: { value_name: "   " } } },
      { OEM: { value_name: "DO-OVERRIDE" } },
    );
    expect((out.attributes as any).OEM.value_name).toBe("DO-OVERRIDE");
  });

  it("IGNORA todo o resto do override — só o OEM entra no create", () => {
    const produto = { ...baseProduct, attributes: { POSITION: { value_name: "Dianteira" } } };
    const out = chamar(produto, {
      OEM: { value_name: "OEM-77" },
      MATERIAL: { value_name: "NAO-DEVE-ENTRAR" },
      POSITION: { value_name: "NAO-DEVE-SOBRESCREVER" },
    });
    const attrs = out.attributes as any;
    expect(attrs.OEM.value_name).toBe("OEM-77");
    expect(attrs.MATERIAL).toBeUndefined();
    expect(attrs.POSITION.value_name).toBe("Dianteira");
  });

  it("MESMO objeto (byte-idêntico) quando não há nada a fazer", () => {
    const produto = { ...baseProduct, attributes: { POSITION: {} } };
    expect(chamar(produto, undefined)).toBe(produto);
    expect(chamar(produto, null)).toBe(produto);
    expect(chamar(produto, {})).toBe(produto);
    expect(chamar(produto, { MATERIAL: { value_name: "X" } })).toBe(produto);
    expect(chamar(produto, { OEM: { value_name: "  " } })).toBe(produto);
    expect(chamar(produto, { OEM: null })).toBe(produto);
  });

  it("override em formato inválido não derruba nem altera nada", () => {
    const produto = { ...baseProduct };
    expect(chamar(produto, [] as any)).toBe(produto);
    expect(chamar(produto, { OEM: "texto-cru" } as any)).toBe(produto);
  });
});

describe("buildMLAttributes — não regride o que já existia", () => {
  it("os atributos fixos seguem intactos com OEM presente", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    const m = byId(out);
    expect(m.get("BRAND")?.value_name).toBe("Volkswagen");
    expect(m.get("SELLER_SKU")?.value_name).toBe("SKU-OEM");
    expect(m.get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
    expect(m.has("MODEL")).toBe(true);
    expect(m.has("YEAR")).toBe(true);
  });

  it("POSITION do operador continua vencendo (spec irmã não regride)", () => {
    const product = {
      ...baseProduct,
      name: "Porta dianteira esquerda Palio",
      attributes: {
        POSITION: { value_id: "VID-DIANT-ESQ", value_name: "Dianteira esquerda" },
        OEM: { value_name: "5U0121049" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, "MLB101763", COM_OEM);
    const pos = out.filter((a: any) => a.id === "POSITION");
    expect(pos).toHaveLength(1);
    expect(pos[0].value_id).toBe("VID-DIANT-ESQ");
  });
});
