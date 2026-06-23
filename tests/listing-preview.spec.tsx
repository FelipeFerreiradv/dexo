import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import {
  buildPreviewViewModel,
  type BuildPreviewArgs,
  type ListingPreviewViewModel,
} from "../app/produtos/components/listing-preview/preview-utils";
import { MlListingPreview } from "../app/produtos/components/listing-preview/ml-listing-preview";
import { ShopeeListingPreview } from "../app/produtos/components/listing-preview/shopee-listing-preview";
import { StepPreview } from "../app/produtos/components/listing-preview/step-preview";

// Mesma lógica/formatador que a Revisão usa (Intl pt-BR BRL, "—" p/ vazio).
const fmt = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
};

const baseArgs = (
  overrides: Partial<BuildPreviewArgs> = {},
): BuildPreviewArgs => ({
  values: {
    name: "Pedal Acelerador Fiat Argo",
    price: 99,
    createMLListing: true,
  },
  compatibilities: [],
  mlAccounts: [],
  shopeeAccounts: [],
  selectedMlAccountIds: [],
  selectedShopeeAccountIds: [],
  mlOptions: [],
  shopeeOptions: [],
  formatCurrency: fmt,
  ...overrides,
});

describe("buildPreviewViewModel", () => {
  it("ML usa mlListingPrice quando preenchido; Shopee sempre usa price", () => {
    const vm = buildPreviewViewModel(
      baseArgs({ values: { price: 99, mlListingPrice: 120 } }),
    );
    expect(vm.mlPriceFormatted).toBe(fmt(120));
    expect(vm.shopeePriceFormatted).toBe(fmt(99));
  });

  it("ML cai para price quando mlListingPrice é null/undefined", () => {
    const vmNull = buildPreviewViewModel(
      baseArgs({ values: { price: 99, mlListingPrice: null } }),
    );
    expect(vmNull.mlPriceFormatted).toBe(fmt(99));
    const vmUndef = buildPreviewViewModel(baseArgs({ values: { price: 99 } }));
    expect(vmUndef.mlPriceFormatted).toBe(fmt(99));
  });

  it("preço/título ausentes degradam para '—'", () => {
    const vm = buildPreviewViewModel(baseArgs({ values: {} }));
    expect(vm.title).toBe("—");
    expect(vm.mlPriceFormatted).toBe("—");
    expect(vm.shopeePriceFormatted).toBe("—");
  });

  it("condição: 'used' → Usado, default → Novo", () => {
    expect(
      buildPreviewViewModel(baseArgs({ values: { mlItemCondition: "used" } }))
        .condition,
    ).toBe("Usado");
    expect(buildPreviewViewModel(baseArgs()).condition).toBe("Novo");
  });

  it("garantia só quando habilitada e com duração válida", () => {
    expect(
      buildPreviewViewModel(
        baseArgs({
          values: {
            mlHasWarranty: true,
            mlWarrantyDuration: 90,
            mlWarrantyUnit: "dias",
          },
        }),
      ).warranty,
    ).toBe("90 dias");
    expect(
      buildPreviewViewModel(baseArgs({ values: { mlHasWarranty: false } }))
        .warranty,
    ).toBeNull();
    expect(
      buildPreviewViewModel(
        baseArgs({ values: { mlHasWarranty: true, mlWarrantyDuration: 0 } }),
      ).warranty,
    ).toBeNull();
  });

  it("imagens: prioriza imageUrls, cai para imageUrl, senão vazio", () => {
    expect(
      buildPreviewViewModel(
        baseArgs({ values: { imageUrls: ["/a.jpg", "/b.jpg"] } }),
      ).images,
    ).toEqual(["/a.jpg", "/b.jpg"]);
    expect(
      buildPreviewViewModel(baseArgs({ values: { imageUrl: "/x.jpg" } }))
        .images,
    ).toEqual(["/x.jpg"]);
    expect(buildPreviewViewModel(baseArgs({ values: {} })).images).toEqual([]);
  });

  it("nome da conta: 1 = nome; 2+ = 'A e mais N'; 0 = fallback", () => {
    const mlAccounts = [
      { id: "1", accountName: "Loja Alpha" },
      { id: "2", accountName: "Loja Beta" },
    ];
    expect(
      buildPreviewViewModel(
        baseArgs({ mlAccounts, selectedMlAccountIds: ["1"] }),
      ).mlAccountLabel,
    ).toBe("Loja Alpha");
    expect(
      buildPreviewViewModel(
        baseArgs({ mlAccounts, selectedMlAccountIds: ["1", "2"] }),
      ).mlAccountLabel,
    ).toBe("Loja Alpha e mais 1");
    expect(buildPreviewViewModel(baseArgs()).mlAccountLabel).toBe(
      "Sua conta Mercado Livre",
    );
  });

  it("breadcrumb ML: usa mlOptions; senão fica genérico", () => {
    const withCat = buildPreviewViewModel(
      baseArgs({
        values: { mlCategory: "MLB123" },
        mlOptions: [{ id: "MLB123", value: "Pedais" }],
      }),
    );
    expect(withCat.mlBreadcrumb[withCat.mlBreadcrumb.length - 1]).toBe(
      "Pedais",
    );

    const generic = buildPreviewViewModel(baseArgs({ values: {} }));
    expect(generic.mlBreadcrumb.length).toBeGreaterThan(0);
    expect(generic.mlBreadcrumb).not.toContain("Pedais");
  });

  it("resumo de compatibilidade só quando há compatibilidades", () => {
    expect(buildPreviewViewModel(baseArgs()).compatibilitySummary).toBeNull();
    const vm = buildPreviewViewModel(
      baseArgs({
        compatibilities: [
          { brand: "Fiat", model: "Argo", yearFrom: 2018, yearTo: 2021 },
        ],
      }),
    );
    expect(vm.compatibilitySummary).toContain("Fiat Argo");
    expect(vm.compatibilitySummary).toContain("2018");
  });

  it("flags showML/showShopee espelham os checkboxes", () => {
    const vm = buildPreviewViewModel(
      baseArgs({
        values: { createMLListing: true, createShopeeListing: false },
      }),
    );
    expect(vm.showML).toBe(true);
    expect(vm.showShopee).toBe(false);
  });

  it("breadcrumb Shopee: usa shopeeOptions; senão fica genérico", () => {
    const withCat = buildPreviewViewModel(
      baseArgs({
        values: { shopeeCategory: "CAT9" },
        shopeeOptions: [{ id: "CAT9", value: "Pedais" }],
      }),
    );
    expect(withCat.shopeeBreadcrumb[withCat.shopeeBreadcrumb.length - 1]).toBe(
      "Pedais",
    );
    const generic = buildPreviewViewModel(baseArgs({ values: {} }));
    expect(generic.shopeeBreadcrumb.length).toBeGreaterThan(0);
    expect(generic.shopeeBreadcrumb).not.toContain("Pedais");
  });

  it("specs: marca/modelo/ano/versão + atributos, ignorando vazios", () => {
    const vm = buildPreviewViewModel(
      baseArgs({
        values: {
          brand: "Fiat",
          model: "Argo",
          year: "",
          version: "  ",
          attributes: {
            Cor: { value_name: "Preto" },
            Material: { value_name: "" },
          },
        },
      }),
    );
    const labels = vm.specs.map((s) => `${s.label}:${s.value}`);
    expect(labels).toContain("Marca:Fiat");
    expect(labels).toContain("Modelo:Argo");
    expect(labels).toContain("Cor:Preto");
    // ano/versão em branco e atributo sem value_name não viram linha
    expect(vm.specs.some((s) => s.label === "Ano")).toBe(false);
    expect(vm.specs.some((s) => s.label === "Versão")).toBe(false);
    expect(vm.specs.some((s) => s.label === "Material")).toBe(false);
  });

  it("stockLabel: undefined → disponível, 0 → sem, 1 → última, n → (n)", () => {
    expect(buildPreviewViewModel(baseArgs({ values: {} })).stockLabel).toBe(
      "Estoque disponível",
    );
    expect(
      buildPreviewViewModel(baseArgs({ values: { stock: 0 } })).stockLabel,
    ).toBe("Sem estoque");
    expect(
      buildPreviewViewModel(baseArgs({ values: { stock: 1 } })).stockLabel,
    ).toBe("Última em estoque!");
    expect(
      buildPreviewViewModel(baseArgs({ values: { stock: 5 } })).stockLabel,
    ).toBe("Estoque disponível (5)");
  });
});

const vmFor = (o: Partial<BuildPreviewArgs> = {}): ListingPreviewViewModel =>
  buildPreviewViewModel(baseArgs(o));

describe("MlListingPreview (render)", () => {
  it("mostra título, preço, condição e 'Vendido por' com a conta", () => {
    const html = renderToString(
      <MlListingPreview
        vm={vmFor({
          values: {
            name: "Pedal Acelerador",
            price: 99,
            mlItemCondition: "new",
          },
          mlAccounts: [{ id: "1", accountName: "JOTABÊ AUTOPEÇAS" }],
          selectedMlAccountIds: ["1"],
        })}
      />,
    );
    expect(html).toContain("Pedal Acelerador");
    expect(html).toContain(fmt(99));
    expect(html).toContain("Novo");
    expect(html).toContain("Vendido por");
    expect(html).toContain("JOTABÊ AUTOPEÇAS");
  });

  it("FRETE GRÁTIS aparece só quando mlFreeShipping; placeholder sem imagem", () => {
    const withFree = renderToString(
      <MlListingPreview
        vm={vmFor({ values: { price: 10, mlFreeShipping: true } })}
      />,
    );
    expect(withFree).toContain("FRETE GRÁTIS");
    expect(withFree).toContain("Sem imagem");

    const noFree = renderToString(
      <MlListingPreview
        vm={vmFor({ values: { price: 10, mlFreeShipping: false } })}
      />,
    );
    expect(noFree).not.toContain("FRETE GRÁTIS");
  });

  it("renderiza com imagem e compatibilidades sem quebrar", () => {
    const html = renderToString(
      <MlListingPreview
        vm={vmFor({
          values: { name: "X", price: 5, imageUrls: ["/p.jpg"] },
          compatibilities: [{ brand: "Fiat", model: "Mobi" }],
        })}
      />,
    );
    expect(html).toContain("/p.jpg");
    expect(html).toContain("Compatível com");
    expect(html).toContain("Fiat Mobi");
  });
});

describe("ShopeeListingPreview (render)", () => {
  it("mostra título, preço laranja e botões; conta na loja", () => {
    const html = renderToString(
      <ShopeeListingPreview
        vm={vmFor({
          values: { name: "Pedal Shopee", price: 84.15 },
          shopeeAccounts: [{ id: "9", accountName: "Desmonte Jotabê" }],
          selectedShopeeAccountIds: ["9"],
        })}
      />,
    );
    expect(html).toContain("Pedal Shopee");
    expect(html).toContain(fmt(84.15));
    expect(html).toContain("Adicionar Ao Carrinho");
    expect(html).toContain("Desmonte Jotabê");
  });

  it("placeholder quando não há imagem", () => {
    const html = renderToString(
      <ShopeeListingPreview vm={vmFor({ values: { price: 1 } })} />,
    );
    expect(html).toContain("Sem imagem");
  });

  it("renderiza a tira de miniaturas quando há mais de uma imagem", () => {
    const html = renderToString(
      <ShopeeListingPreview
        vm={vmFor({ values: { price: 1, imageUrls: ["/a.jpg", "/b.jpg"] } })}
      />,
    );
    expect(html).toContain("/a.jpg");
    expect(html).toContain("/b.jpg");
  });
});

describe("StepPreview (orquestrador)", () => {
  it("nenhum marcado → estado vazio amigável", () => {
    const html = renderToString(
      <StepPreview
        values={{ createMLListing: false, createShopeeListing: false }}
        compatibilities={[]}
        mlAccounts={[]}
        shopeeAccounts={[]}
        selectedMlAccountIds={[]}
        selectedShopeeAccountIds={[]}
        mlOptions={[]}
        shopeeOptions={[]}
        formatCurrency={fmt}
      />,
    );
    expect(html).toContain("não marcou criar anúncio");
  });

  it("só ML → prévia ML (sem marcadores da Shopee)", () => {
    const html = renderToString(
      <StepPreview
        values={{ name: "P", price: 10, createMLListing: true }}
        compatibilities={[]}
        mlAccounts={[]}
        shopeeAccounts={[]}
        selectedMlAccountIds={[]}
        selectedShopeeAccountIds={[]}
        mlOptions={[]}
        shopeeOptions={[]}
        formatCurrency={fmt}
      />,
    );
    expect(html).toContain("Comprar agora"); // marcador ML
    expect(html).not.toContain("Buscar na Shopee"); // marcador Shopee
  });

  it("só Shopee → prévia Shopee (sem marcadores do ML)", () => {
    const html = renderToString(
      <StepPreview
        values={{ name: "P", price: 10, createShopeeListing: true }}
        compatibilities={[]}
        mlAccounts={[]}
        shopeeAccounts={[]}
        selectedMlAccountIds={[]}
        selectedShopeeAccountIds={[]}
        mlOptions={[]}
        shopeeOptions={[]}
        formatCurrency={fmt}
      />,
    );
    expect(html).toContain("Buscar na Shopee"); // marcador Shopee
    expect(html).not.toContain("Comprar agora"); // marcador ML
  });

  it("ambos → abas ML/Shopee (gatilhos das duas) e corpo da aba ativa (ML)", () => {
    const html = renderToString(
      <StepPreview
        values={{
          name: "P",
          price: 10,
          createMLListing: true,
          createShopeeListing: true,
        }}
        compatibilities={[]}
        mlAccounts={[]}
        shopeeAccounts={[]}
        selectedMlAccountIds={[]}
        selectedShopeeAccountIds={[]}
        mlOptions={[]}
        shopeeOptions={[]}
        formatCurrency={fmt}
      />,
    );
    // Os dois gatilhos de aba (logos + rótulos) aparecem.
    expect(html).toContain("/marketplaces/mercado-livre.svg");
    expect(html).toContain("/marketplaces/shopee.svg");
    expect(html).toContain("Mercado Livre");
    expect(html).toContain("Shopee");
    // A aba padrão (ML) tem seu CORPO renderizado.
    expect(html).toContain("Comprar agora"); // marcador do corpo ML
    // Obs: o Radix Tabs só renderiza no servidor (renderToString) o conteúdo da
    // aba ATIVA; o corpo da Shopee (aba inativa) não aparece aqui — por isso o
    // mock da Shopee é coberto diretamente no describe "ShopeeListingPreview".
    expect(html).not.toContain("Buscar na Shopee"); // corpo Shopee não-SSR
  });
});
