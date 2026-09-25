import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fiação da ficha semeada nos componentes (a suíte não tem jsdom — mesmo
 * padrão de create-product-ml-required-check-wiring.spec.ts). A LÓGICA é
 * testada em ml-ficha-semeada.spec.ts e ml-create-prevalidacao.spec.ts; aqui
 * só se trava que os componentes a usam.
 */
const ler = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

describe("Editar produto", () => {
  const src = ler("app/produtos/components/edit-product-dialog.tsx");

  it("o reset ao abrir leva a ficha gravada (antes ficava de fora e a ficha abria vazia)", () => {
    const ini = src.indexOf("const fichaAberta = seedMlFicha(product.attributes);");
    expect(ini).toBeGreaterThan(-1);
    const reset = src.slice(ini, src.indexOf("});", src.indexOf("reset({", ini)));
    expect(reset).toContain("fichaAbertaRef.current = fichaAberta;");
    expect(reset).toContain("attributes: fichaAberta,");
  });

  it("salvar no modo produto só manda a ficha quando ela MUDOU", () => {
    const ini = src.indexOf('// Modo "editar produto" (sem listingContext)');
    expect(ini).toBeGreaterThan(-1);
    const put = src.indexOf("body: JSON.stringify(cleanData)", ini);
    const trecho = src.slice(ini, put);
    expect(trecho).toContain("if (sameMlFicha(cleanData.attributes, fichaAbertaRef.current)) {");
    expect(trecho).toContain("delete cleanData.attributes;");
    expect(trecho).toContain('method: "PUT"');
  });
});

describe("Anunciar em massa — Revisão individual", () => {
  it("a lista de produtos passa a ficha gravada ao assistente", () => {
    const src = ler("app/produtos/components/products-list.tsx");
    const bloco = src.slice(src.indexOf("const bulkListingProducts"), src.indexOf("[products, selectedIds]"));
    expect(bloco).toContain("attributes: (p as { attributes?: unknown }).attributes ?? null,");
  });

  it("o assistente repassa a ficha à revisão e usa as sementes no envio e nas duas checagens", () => {
    const src = ler("app/produtos/components/bulk-listing-wizard.tsx");
    expect(src).toContain("attributes: p.attributes,");
    expect(src).toContain("() => reviewFichaSeeds(reviewProducts),");
    expect(src.match(/reviewSeeds,\n\s*\);/g)?.length).toBe(2); // checagem 1 + envio
    expect(src).toContain("buildMlReviewCheckItems(idsSelecionados, reviewMap, reviewSeeds)");
  });

  it("a 1ª visita de cada produto semeia a ficha com a do produto", () => {
    const src = ler("app/produtos/components/bulk-review/use-per-product-listing.ts");
    const bloco = src.slice(src.indexOf("if (!cfg) {"), src.indexOf("form.reset(cfg);"));
    expect(bloco).toContain("const ficha = seedMlFicha(p.attributes);");
    expect(bloco).toContain("if (Object.keys(ficha).length > 0) cfg.attributes = ficha;");
  });
});
