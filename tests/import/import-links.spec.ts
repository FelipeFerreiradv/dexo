import { describe, it, expect, vi } from "vitest";
import XLSX from "xlsx";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    product: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    location: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    scrap: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
  },
}));

import {
  executeLinksPlan,
  runVaaptLinks,
  type LinksExecDeps,
  type LinksRunnerDeps,
  type LinkedProductRef,
} from "../../app/usecases/import/executors/product-links.executor";
import { CapacityExceededError } from "../../app/usecases/location.usercase";
import type { LocationExecDeps } from "../../app/usecases/import/executors/locations.executor";
import type { ScrapsExecDeps } from "../../app/usecases/import/executors/scraps.executor";
import { detectFile } from "../../app/usecases/import/import-detector";
import { newReport } from "../../app/usecases/import/import.types";
import type { ImportContext } from "../../app/usecases/import/import.types";
import type { LinkPlanItem } from "../../app/usecases/import/mappers/vinculos.mapper";

function makeDeps(
  products: LinkedProductRef[],
  opts: {
    locationCodes?: Array<{ id: string; code: string }>;
    scraps?: Array<{ id: string; notes: string | null }>;
    capacityFail?: string; // locationId que estoura capacidade
  } = {},
) {
  const attachCalls: Array<{ locationId: string; ids: string[] }> = [];
  const linkCalls: Array<{ scrapId: string; ids: string[] }> = [];
  const deps: LinksExecDeps = {
    loadProductsBySkuNormalized: vi.fn(async (_u, norms: string[]) =>
      products.filter((p) => p.skuNormalized && norms.includes(p.skuNormalized)),
    ),
    loadLocationCodes: vi.fn(async () => opts.locationCodes ?? []),
    loadExistingScraps: vi.fn(async () => opts.scraps ?? []),
    attachProducts: vi.fn(async (locationId: string, ids: string[]) => {
      if (opts.capacityFail === locationId) {
        throw new CapacityExceededError("Localização lotada", {
          currentCount: 1,
          maxCapacity: 1,
          attempting: ids.length,
          wouldExceedBy: ids.length,
          acceptedIds: [],
          excededIds: ids,
        });
      }
      attachCalls.push({ locationId, ids });
      return {
        attached: ids.map((id) => ({ id, sku: id, name: id })),
        alreadyAttached: [],
        skipped: [],
        location: {
          id: locationId,
          code: locationId,
          productsCount: ids.length,
          maxCapacity: 0,
        },
      };
    }) as LinksExecDeps["attachProducts"],
    linkScrapMany: vi.fn(async (scrapId: string, ids: string[]) => {
      linkCalls.push({ scrapId, ids });
      return { count: ids.length };
    }),
  };
  return { deps, attachCalls, linkCalls };
}

const ctx = (dryRun: boolean): ImportContext => ({
  targetUserId: "admin-1",
  files: [],
  dryRun,
});

const product = (
  id: string,
  sku: string,
  extra: Partial<LinkedProductRef> = {},
): LinkedProductRef => ({
  id,
  sku,
  skuNormalized: sku.trim().toLowerCase(),
  locationId: null,
  scrapId: null,
  ...extra,
});

describe("import/vinculos — casamento por skuNormalized", () => {
  it("casa com caixa/espaço divergentes; sem_produto e ambíguos nunca vinculam", async () => {
    const products = [
      product("p1", "ABC-1"),
      // dois produtos com o MESMO normalizado ("dup-1") = ambíguo
      product("p2", "DUP-1"),
      product("p3", "dup-1 "),
    ];
    const items: LinkPlanItem[] = [
      { linha: 1, sku: " abc-1 ", locationCode: "LOCAL1", scrapKey: null },
      { linha: 2, sku: "DUP-1", locationCode: "LOCAL1", scrapKey: null },
      { linha: 3, sku: "VAAPT-MLB123", locationCode: "LOCAL1", scrapKey: null },
    ];
    const { deps, attachCalls } = makeDeps(products, {
      locationCodes: [{ id: "loc-1", code: "LOCAL1" }],
    });
    const report = newReport("VAAPT", "VINCULOS", "admin-1", false);
    await executeLinksPlan(ctx(false), report, items, {}, deps);

    expect(report.contadores.produtos_casados).toBe(1);
    expect(report.semProduto?.total).toBe(1);
    expect(report.semProduto?.exemplos).toEqual(["VAAPT-MLB123"]);
    expect(report.ambiguos?.total).toBe(1);
    expect(report.ambiguos?.exemplos[0].produtoIds.sort()).toEqual(["p2", "p3"]);
    // Só o produto casado inequivocamente foi vinculado.
    expect(attachCalls).toEqual([{ locationId: "loc-1", ids: ["p1"] }]);
  });

  it("já vinculado ao mesmo destino = no-op contabilizado (idempotência)", async () => {
    const products = [
      product("p1", "A1", { locationId: "loc-1", scrapId: "s-1" }),
    ];
    const items: LinkPlanItem[] = [
      { linha: 1, sku: "A1", locationCode: "LOCAL1", scrapKey: "36" },
    ];
    const { deps, attachCalls, linkCalls } = makeDeps(products, {
      locationCodes: [{ id: "loc-1", code: "LOCAL1" }],
      scraps: [{ id: "s-1", notes: "Import Dexo · veículo #36" }],
    });
    const report = newReport("VAAPT", "VINCULOS", "admin-1", false);
    await executeLinksPlan(ctx(false), report, items, {}, deps);
    expect(report.contadores.local_ja_correto).toBe(1);
    expect(report.contadores.sucata_ja_correta).toBe(1);
    expect(attachCalls).toEqual([]);
    expect(linkCalls).toEqual([]);
  });

  it("localização inexistente → erro de linha; sucata inexistente → aviso; nada é gravado", async () => {
    const products = [product("p1", "A1")];
    const items: LinkPlanItem[] = [
      {
        linha: 1,
        sku: "A1",
        locationCode: "NAO-EXISTE",
        locationLabel: "Não Existe",
        scrapKey: "999",
      },
    ];
    const { deps, attachCalls, linkCalls } = makeDeps(products);
    const report = newReport("VAAPT", "VINCULOS", "admin-1", false);
    await executeLinksPlan(ctx(false), report, items, {}, deps);
    expect(report.contadores.local_nao_encontrado).toBe(1);
    expect(report.contadores.sucata_nao_encontrada).toBe(1);
    expect(report.erros.some((e) => e.motivo.includes("Não Existe"))).toBe(true);
    expect(attachCalls).toEqual([]);
    expect(linkCalls).toEqual([]);
  });

  it("PRÉVIA não chama attach nem linkScrapMany", async () => {
    const products = [product("p1", "A1")];
    const items: LinkPlanItem[] = [
      { linha: 1, sku: "A1", locationCode: "LOCAL1", scrapKey: "36" },
    ];
    const { deps, attachCalls, linkCalls } = makeDeps(products, {
      locationCodes: [{ id: "loc-1", code: "LOCAL1" }],
      scraps: [{ id: "s-1", notes: "Legado 704 · veículo #36" }],
    });
    const report = newReport("VAAPT", "VINCULOS", "admin-1", true);
    await executeLinksPlan(ctx(true), report, items, {}, deps);
    expect(report.contadores.local_a_vincular).toBe(1);
    expect(report.contadores.sucata_a_vincular).toBe(1);
    expect(attachCalls).toEqual([]);
    expect(linkCalls).toEqual([]);
  });

  it("chunking ≤200 por chamada de attach/linkScrapMany", async () => {
    const products = Array.from({ length: 250 }, (_, i) =>
      product(`p${i}`, `SKU${i}`),
    );
    const items: LinkPlanItem[] = products.map((p, i) => ({
      linha: i + 1,
      sku: p.sku,
      locationCode: "LOCAL1",
      scrapKey: "36",
    }));
    const { deps, attachCalls, linkCalls } = makeDeps(products, {
      locationCodes: [{ id: "loc-1", code: "LOCAL1" }],
      scraps: [{ id: "s-1", notes: "Import Dexo · veículo #36" }],
    });
    const report = newReport("VAAPT", "VINCULOS", "admin-1", false);
    await executeLinksPlan(ctx(false), report, items, {}, deps);
    expect(attachCalls.map((c) => c.ids.length)).toEqual([200, 50]);
    expect(linkCalls.map((c) => c.ids.length)).toEqual([200, 50]);
    expect(report.contadores.local_vinculado).toBe(250);
    expect(report.contadores.sucata_vinculada).toBe(250);
  });

  it("CapacityExceededError em UMA localização não aborta o job (as demais seguem)", async () => {
    const products = [product("p1", "A1"), product("p2", "B1")];
    const items: LinkPlanItem[] = [
      { linha: 1, sku: "A1", locationCode: "CHEIA", scrapKey: null },
      { linha: 2, sku: "B1", locationCode: "LIVRE", scrapKey: null },
    ];
    const { deps, attachCalls } = makeDeps(products, {
      locationCodes: [
        { id: "loc-cheia", code: "CHEIA" },
        { id: "loc-livre", code: "LIVRE" },
      ],
      capacityFail: "loc-cheia",
    });
    const report = newReport("VAAPT", "VINCULOS", "admin-1", false);
    await executeLinksPlan(ctx(false), report, items, {}, deps);
    expect(report.contadores.capacidade_excedida).toBe(1);
    expect(report.contadores.local_vinculado).toBe(1);
    expect(attachCalls).toEqual([{ locationId: "loc-livre", ids: ["p2"] }]);
  });
});

describe("import/vinculos — runner composto Vaapt (localizações + vínculo)", () => {
  function pecasXlsx() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["# Cod Peca", "MLB", "Nome peca", "Localizacao", "Cod Veiculo"],
        ["100", "MLB1", "PARACHOQUE", "Local 44 - Caixa 9", "36"],
        ["200", "MLB2", "FAROL", "LOCAL 1", null],
      ]),
      "Planilha1",
    );
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return detectFile({ fieldname: "file", filename: "pecas.xlsx", buffer });
  }

  it("cria as localizações do próprio arquivo e vincula usando os ids criados", async () => {
    let locSeq = 0;
    const locations: LocationExecDeps = {
      locationUseCase: {
        createLean: vi.fn(async (d: { code: string }) => ({
          id: `loc-${++locSeq}`,
          code: d.code,
        })) as never,
      },
      loadExistingCodes: vi.fn(async () => []),
    };
    const scraps: ScrapsExecDeps = {
      scrapUseCase: { create: vi.fn() },
      loadExistingScraps: vi.fn(async () => [
        { id: "s-36", notes: "Legado 704 · veículo #36", plate: null, chassis: null },
      ]),
      loadLocationCodes: vi.fn(async () => []),
    };
    const { deps: links, attachCalls, linkCalls } = makeDeps(
      [product("p1", "100"), product("p2", "200")],
      { scraps: [{ id: "s-36", notes: "Legado 704 · veículo #36" }] },
    );
    // O arquivo-ponte clássico não tem coluna "Etiqueta": `resolverPorEtiqueta`
    // sai antes de consultar, e este stub nunca é chamado.
    const runnerDeps: LinksRunnerDeps = {
      links,
      locations,
      scraps,
      etiqueta: { loadTodosOsProdutos: async () => [] },
    };

    const report = await runVaaptLinks(
      { targetUserId: "admin-1", files: [pecasXlsx()], dryRun: false },
      runnerDeps,
    );

    expect(report.porFase?.localizacoes.contadores.criadas).toBe(2);
    // Vínculo usa os ids recém-criados na MESMA execução.
    expect(attachCalls).toEqual([
      { locationId: "loc-1", ids: ["p1"] },
      { locationId: "loc-2", ids: ["p2"] },
    ]);
    expect(linkCalls).toEqual([{ scrapId: "s-36", ids: ["p1"] }]);
    expect(report.contadores.produtos_casados).toBe(2);
  });
});
