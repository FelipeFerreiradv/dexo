import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    location: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    product: { findMany: vi.fn(async () => []) },
  },
}));

import { mapIbrEstoque } from "../../app/usecases/import/mappers/ibr-estoque.mapper";
import {
  runIbrEstoque,
  type IbrEstoqueDeps,
} from "../../app/usecases/import/executors/ibr-estoque.executor";
import { detectFile } from "../../app/usecases/import/import-detector";
import type { ImportContext } from "../../app/usecases/import/import.types";
import type { ProductCreate } from "../../app/interfaces/product.interface";

const HEADER =
  "ProductId,SKU,BarCode,Description,Brand,Model,Active,QuantidadeEstoque,EstoqueMinimo,CustoAtual,CustoReal,ValorVenda,Ncm,Cest,LocationId,LocalizacaoSiglas,LocalizacaoDescricao,CreatedAt,UpdatedAt";

function estoqueCsv(lines: string[]) {
  return detectFile({
    fieldname: "file",
    filename: "estoque.csv",
    buffer: Buffer.from([HEADER, ...lines].join("\n"), "utf8"),
  });
}

function makeDeps(
  existing: Array<{
    id: string;
    sku: string;
    skuNormalized: string | null;
    locationId: string | null;
  }> = [],
) {
  const created: ProductCreate[] = [];
  const attachCalls: Array<{ locationId: string; ids: string[] }> = [];
  const locCreated: Array<{ code: string; parentId?: string }> = [];
  let locSeq = 0;
  const deps: IbrEstoqueDeps = {
    locations: {
      locationUseCase: {
        createLean: vi.fn(async (d: { code: string; parentId?: string }) => {
          locCreated.push({ code: d.code, parentId: d.parentId });
          return { id: `loc-${++locSeq}`, code: d.code } as never;
        }),
      },
      loadExistingCodes: vi.fn(async () => []),
    },
    productUseCase: {
      create: vi.fn(async (data: ProductCreate) => {
        created.push(data);
        return { id: `p-${created.length}` } as never;
      }),
    },
    // Espelha o preload real: casa por skuNormalized IN + carrega TODOS os
    // legados com skuNormalized NULL (que o IN nunca pega).
    loadProductsBySkuNormalized: vi.fn(async (_u, norms: string[]) => [
      ...existing.filter(
        (e) => e.skuNormalized && norms.includes(e.skuNormalized),
      ),
      ...existing.filter((e) => e.skuNormalized === null),
    ]),
    attachProducts: vi.fn(async (locationId: string, ids: string[]) => {
      attachCalls.push({ locationId, ids });
      return {
        attached: ids.map((id) => ({ id, sku: id, name: id })),
        alreadyAttached: [],
        skipped: [],
        location: { id: locationId, code: locationId, productsCount: ids.length, maxCapacity: 0 },
      };
    }) as IbrEstoqueDeps["attachProducts"],
  };
  return { deps, created, attachCalls, locCreated };
}

const ctx = (dryRun: boolean, file: ReturnType<typeof estoqueCsv>): ImportContext => ({
  targetUserId: "admin-1",
  files: [file],
  dryRun,
});

describe("import/ibr-estoque — mapper", () => {
  it("deriva a árvore de localizações (pais antes de filhos) e ignora SKU -1", () => {
    const file = estoqueCsv([
      '100,2492,SEM GTIN,Farol,Ford,KA,t,3,0,0.01,15.5,160,8708,0000,guid1,"BARR. > CORR.-B > PRT.-56",Barracao,,',
      '101,3947,,Lanterna,Fiat,Uno,t,1,0,0.01,0.01,90,,,,"BARR. > CORR.-B > PRT.-57",,, ',
      '102,-1,SEM GTIN,Sem codigo,Fly,,t,9,0,0.01,0.01,581,,,,,,,',
    ]);
    const r = mapIbrEstoque(file);
    expect(r.produtos).toHaveLength(2); // -1 ignorado
    expect(r.semSku).toBe(1);

    // Árvore: BARR. → BARR. > CORR.-B → (PRT.-56, PRT.-57)
    const codes = r.locationItems.map((l) => l.code);
    expect(codes).toContain("BARR.");
    expect(codes).toContain("BARR. > CORR.-B");
    expect(codes).toContain("BARR. > CORR.-B > PRT.-56");
    // Pais vêm antes dos filhos (profundidade crescente).
    expect(codes.indexOf("BARR.")).toBeLessThan(codes.indexOf("BARR. > CORR.-B"));
    const prt56 = r.locationItems.find((l) => l.code === "BARR. > CORR.-B > PRT.-56");
    expect(prt56?.parentCode).toBe("BARR. > CORR.-B");

    // Produto: preço/custo/loc.
    const p = r.produtos[0];
    expect(p.sku).toBe("2492");
    expect(p.price).toBe(160);
    expect(p.cost).toBe(15.5); // custo real > 0.01
    expect(r.produtos[1].cost).toBeNull(); // 0.01 placeholder → null
    expect(p.locationCode).toBe("BARR. > CORR.-B > PRT.-56");
  });

  it("dedup intra-arquivo por SKU (case/espaço)", () => {
    const r = mapIbrEstoque(
      estoqueCsv([
        "1,ABC,,X,,,t,1,0,0,0,10,,,,,,,",
        "2,abc,,Y,,,t,1,0,0,0,20,,,,,,,",
      ]),
    );
    expect(r.produtos).toHaveLength(1);
    expect(r.duplicadosSku).toBe(1);
  });
});

describe("import/ibr-estoque — executor", () => {
  const FILE = () =>
    estoqueCsv([
      '100,2492,,Farol,Ford,KA,t,3,0,0.01,15.5,160,8708,,,"BARR. > CX 1",Barracao,,',
      '101,9999,,Novo,Fiat,Uno,t,1,0,0.01,0.01,90,,,,"BARR. > CX 2",,,',
    ]);

  it("PRÉVIA não escreve e REFLETE o vínculo/sobrescrita que o apply fará", async () => {
    // Produto existente numa localização ANTIGA; o arquivo o move p/ outra.
    const { deps, created, attachCalls } = makeDeps([
      { id: "p-exist", sku: "2492", skuNormalized: "2492", locationId: "loc-antiga" },
    ]);
    const report = await runIbrEstoque(ctx(true, FILE()), deps);
    expect(deps.productUseCase.create).not.toHaveBeenCalled();
    expect(attachCalls).toEqual([]);
    expect(created).toEqual([]);
    // 2492 existe → casado; 9999 não existe → a_criar.
    expect(report.porFase?.produtos.contadores.produtos_casados).toBe(1);
    expect(report.porFase?.produtos.contadores.a_criar).toBe(1);
    // A prévia mostra que a localização será vinculada E que é sobrescrita
    // (não esconde a mudança que o apply executaria).
    expect(report.porFase?.produtos.contadores.local_a_vincular).toBe(1);
    expect(report.porFase?.produtos.contadores.local_sobrescrito).toBe(1);
  });

  it("APPLY: vincula o existente por SKU e CRIA o faltante já com localização", async () => {
    const { deps, created, attachCalls, locCreated } = makeDeps([
      { id: "p-exist", sku: "2492", skuNormalized: "2492", locationId: null },
    ]);
    const report = await runIbrEstoque(ctx(false, FILE()), deps);

    // Localizações criadas (árvore): BARR., BARR. > CX 1, BARR. > CX 2.
    expect(locCreated.map((l) => l.code).sort()).toEqual([
      "BARR.",
      "BARR. > CX 1",
      "BARR. > CX 2",
    ]);
    // Existente (2492) → attach à sua localização.
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].ids).toEqual(["p-exist"]);
    // Faltante (9999) → criado com localização + SEMINOVO + marker.
    expect(created).toHaveLength(1);
    expect(created[0].sku).toBe("9999");
    expect(created[0].quality).toBe("SEMINOVO");
    expect(created[0].locationId).toBeTruthy();
    expect(created[0].location).toBe("BARR. > CX 2");
    expect((created[0].attributes as Record<string, { value_name?: string }>).migration.value_name).toBe("IBR");
    expect(report.contadores.produtos_criados).toBe(1);
    expect(report.contadores.produtos_vinculados).toBe(1);
  });

  it("idempotência: 2ª rodada (tudo já existe) não cria nem re-vincula", async () => {
    // Simula pós-1ª rodada: ambos produtos existem, já na localização certa.
    const { deps, created, attachCalls } = makeDeps([
      { id: "p1", sku: "2492", skuNormalized: "2492", locationId: "loc-1" },
      { id: "p2", sku: "9999", skuNormalized: "9999", locationId: "loc-2" },
    ]);
    // Localizações já existem → o executor as reusa (loadExistingCodes).
    deps.locations.loadExistingCodes = vi.fn(async () => [
      { id: "locB", code: "BARR." },
      { id: "loc-1", code: "BARR. > CX 1" },
      { id: "loc-2", code: "BARR. > CX 2" },
    ]);
    const report = await runIbrEstoque(ctx(false, FILE()), deps);
    expect(created).toEqual([]);
    expect(attachCalls).toEqual([]); // já na localização correta
    expect(report.porFase?.produtos.contadores.local_ja_correto).toBe(2);
    expect(report.contadores.produtos_criados ?? 0).toBe(0);
  });

  it("SKU que casa 2 produtos = ambíguo, não vincula nem cria", async () => {
    const { deps, created, attachCalls } = makeDeps([
      { id: "a", sku: "2492", skuNormalized: "2492", locationId: null },
      { id: "b", sku: "2492 ", skuNormalized: "2492", locationId: null },
    ]);
    const report = await runIbrEstoque(
      ctx(false, estoqueCsv(['100,2492,,Farol,,,t,1,0,0,0,10,,,,"BARR. > CX 1",,,'])),
      deps,
    );
    expect(report.porFase?.produtos.contadores.sku_ambiguo).toBe(1);
    expect(created).toEqual([]);
    expect(attachCalls).toEqual([]);
  });

  it("ANTI-DUPLICAÇÃO: produto legado com skuNormalized NULL é casado e vinculado, nunca recriado", async () => {
    // Cenário da auditoria: legado sem skuNormalized, caixa divergente
    // (banco "ABC123" vs arquivo "abc123"). Sem o preload de legados, o
    // executor criaria um 2º produto (unique é case-sensitive).
    const { deps, created, attachCalls } = makeDeps([
      { id: "p-legado", sku: "ABC123", skuNormalized: null, locationId: null },
    ]);
    const report = await runIbrEstoque(
      ctx(false, estoqueCsv(['100,abc123,,Farol,,,t,1,0,0,0,10,,,,"BARR. > CX 1",,,'])),
      deps,
    );
    // Casou com o legado → vincula, NÃO cria.
    expect(created).toEqual([]);
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].ids).toEqual(["p-legado"]);
    expect(report.porFase?.produtos.contadores.produtos_casados).toBe(1);
    expect(report.porFase?.produtos.contadores.produtos_criados ?? 0).toBe(0);
  });

  it("create que falha por 'já existe' (corrida) vira skip, não erro", async () => {
    const { deps } = makeDeps([]);
    (deps.productUseCase.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Produto com esse sku já existe"),
    );
    const report = await runIbrEstoque(
      ctx(false, estoqueCsv(['100,7777,,Peca,,,t,1,0,0,0,10,,,,"BARR. > CX 9",,,'])),
      deps,
    );
    expect(report.porFase?.produtos.contadores.ja_existiam_corrida).toBe(1);
    expect(report.porFase?.produtos.contadores.erros ?? 0).toBe(0);
  });
});
