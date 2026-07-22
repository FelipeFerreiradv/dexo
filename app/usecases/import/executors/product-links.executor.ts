/**
 * VÍNCULO DE PRODUTOS POR SKU — o coração da importação. Produtos JÁ existem
 * (criados pelo "Importar anúncios", chaveados por SKU); aqui cada linha do
 * arquivo-ponte é casada ao produto por `skuNormalized` (nunca `findBySku`,
 * que é cru/case-sensitive) e recebe:
 *
 * - `locationId` via `LocationUseCase.attachProducts` (checa capacidade,
 *   grava o caminho textual em Product.location, idempotente, ≤200/chamada);
 * - `scrapId` via `ProductUseCase.linkScrapMany` (guarda de tenant, ≤200).
 *
 * Regras à prova de erro:
 * - SKU sem produto ⇒ `sem_produto[]` (pular e reportar — decisão fechada);
 * - SKU que casa MAIS de um produto (normalizado igual) ⇒ `ambiguos[]`,
 *   nunca vincula;
 * - destino não resolvido ⇒ erro de linha, nunca grava;
 * - `CapacityExceededError` de uma localização ⇒ reporta e SEGUE (o job
 *   nunca aborta);
 * - já vinculado ao mesmo destino ⇒ no-op contabilizado (idempotência).
 */

import prisma from "../../../lib/prisma";
import { normalizeSku } from "../../../lib/sku";
import {
  CapacityExceededError,
  LocationUseCase,
} from "../../location.usercase";
import { ProductUseCase } from "../../product.usercase";
import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  MAX_EXAMPLES,
  addIssue,
  bump,
  newReport,
} from "../import.types";
import { chunk } from "../lib/normalize";
import { parseScrapWdMarker, parseVehicleMarker } from "../lib/markers";
import { fileOfKind } from "../import-detector";
import type { LinkPlanItem, LinksMapResult } from "../mappers/vinculos.mapper";
import { mapVaaptLinks, mapWdLinks } from "../mappers/vinculos.mapper";
import { mapVaaptLocations } from "../mappers/vaapt-localizacoes.mapper";
import { mapWdLocations } from "../mappers/wd-localizacoes.mapper";
import { mapVaaptScraps, mapWdScraps } from "../mappers/sucatas.mapper";
import {
  executeLocationPlan,
  defaultLocationDeps,
  type LocationExecDeps,
} from "./locations.executor";
import {
  executeScrapsPlan,
  defaultScrapsDeps,
  type ScrapsExecDeps,
} from "./scraps.executor";

export interface LinkedProductRef {
  id: string;
  sku: string;
  skuNormalized: string | null;
  locationId: string | null;
  scrapId: string | null;
}

export interface LinksExecDeps {
  /** Preload de UM chunk de skus normalizados (o executor faz o chunking). */
  loadProductsBySkuNormalized: (
    userId: string,
    skusNormalized: string[],
  ) => Promise<LinkedProductRef[]>;
  loadLocationCodes: (
    userId: string,
  ) => Promise<Array<{ id: string; code: string }>>;
  loadExistingScraps: (
    userId: string,
  ) => Promise<Array<{ id: string; notes: string | null }>>;
  attachProducts: LocationUseCase["attachProducts"];
  linkScrapMany: ProductUseCase["linkScrapMany"];
}

const locationUseCase = new LocationUseCase();
const productUseCase = new ProductUseCase();

export const defaultLinksDeps: LinksExecDeps = {
  loadProductsBySkuNormalized: (userId, skusNormalized) =>
    prisma.product.findMany({
      where: { userId, skuNormalized: { in: skusNormalized } },
      select: {
        id: true,
        sku: true,
        skuNormalized: true,
        locationId: true,
        scrapId: true,
      },
    }),
  loadLocationCodes: (userId) =>
    prisma.location.findMany({
      where: { userId },
      select: { id: true, code: true },
    }),
  loadExistingScraps: (userId) =>
    prisma.scrap.findMany({
      where: { userId },
      select: { id: true, notes: true },
    }),
  attachProducts: locationUseCase.attachProducts.bind(locationUseCase),
  linkScrapMany: productUseCase.linkScrapMany.bind(productUseCase),
};

/** Mapas pré-resolvidos (modo pacote passa os das fases anteriores). */
export interface LinksResolvedMaps {
  locCodeToId?: Map<string, string>;
  scrapKeyToId?: Map<string, string>;
}

const BATCH = 200; // limite hard do attachProducts (e adotado no linkScrapMany)
const PRELOAD_CHUNK = 500;

export async function executeLinksPlan(
  ctx: ImportContext,
  report: ImportReport,
  items: LinkPlanItem[],
  maps: LinksResolvedMaps,
  deps: LinksExecDeps = defaultLinksDeps,
): Promise<void> {
  bump(report, "linhas_de_vinculo", items.length);

  /* 1. Casamento por skuNormalized (preload em chunks; zero query por linha). */
  const normToItems = new Map<string, LinkPlanItem[]>();
  for (const item of items) {
    const norm = normalizeSku(item.sku);
    if (!norm) {
      bump(report, "erros");
      addIssue(report.erros, { linha: item.linha, motivo: "SKU vazio" });
      continue;
    }
    const arr = normToItems.get(norm) ?? [];
    arr.push(item);
    normToItems.set(norm, arr);
  }

  const allNorms = Array.from(normToItems.keys());
  const bySkuNorm = new Map<string, LinkedProductRef[]>();
  let preloaded = 0;
  for (const part of chunk(allNorms, PRELOAD_CHUNK)) {
    const refs = await deps.loadProductsBySkuNormalized(ctx.targetUserId, part);
    for (const ref of refs) {
      if (!ref.skuNormalized) continue;
      const arr = bySkuNorm.get(ref.skuNormalized) ?? [];
      arr.push(ref);
      bySkuNorm.set(ref.skuNormalized, arr);
    }
    preloaded += part.length;
    ctx.onProgress?.({
      fase: "casando produtos por SKU",
      processadas: preloaded,
      total: allNorms.length,
    });
  }

  const semProduto: string[] = [];
  let semProdutoTotal = 0;
  const ambiguos: Array<{ sku: string; produtoIds: string[] }> = [];
  let ambiguosTotal = 0;
  const matched: Array<{ item: LinkPlanItem; product: LinkedProductRef }> = [];

  for (const [norm, itemsOfSku] of normToItems) {
    const refs = bySkuNorm.get(norm) ?? [];
    if (refs.length === 0) {
      semProdutoTotal += itemsOfSku.length;
      for (const it of itemsOfSku) {
        if (semProduto.length < MAX_EXAMPLES) semProduto.push(it.sku);
      }
      continue;
    }
    if (refs.length > 1) {
      ambiguosTotal += itemsOfSku.length;
      if (ambiguos.length < MAX_EXAMPLES) {
        ambiguos.push({
          sku: itemsOfSku[0].sku,
          produtoIds: refs.map((r) => r.id),
        });
      }
      continue;
    }
    // Duas linhas com SKUs CRUS distintos que normalizam igual ("X10" e
    // "x10") casariam o MESMO produto com destinos possivelmente
    // divergentes — flip-flop a cada re-execução. Só a 1ª linha vale
    // (determinístico); as demais são contadas e avisadas.
    matched.push({ item: itemsOfSku[0], product: refs[0] });
    if (itemsOfSku.length > 1) {
      bump(report, "linhas_extras_mesmo_sku", itemsOfSku.length - 1);
      bump(report, "avisos");
      addIssue(report.avisos, {
        linha: itemsOfSku[1].linha,
        motivo: `SKU "${itemsOfSku[1].sku}" repete "${itemsOfSku[0].sku}" (diferem só em caixa/espaço) — apenas a 1ª linha vincula`,
      });
    }
  }

  bump(report, "produtos_casados", matched.length);
  bump(report, "sem_produto", semProdutoTotal);
  bump(report, "sku_ambiguo", ambiguosTotal);
  report.semProduto = { total: semProdutoTotal, exemplos: semProduto };
  report.ambiguos = { total: ambiguosTotal, exemplos: ambiguos };

  /* 2. Vínculo de LOCALIZAÇÃO (agrupado por destino, chunks ≤200, serial). */
  let locCodeToId = maps.locCodeToId;
  if (!locCodeToId && matched.some(({ item }) => item.locationCode)) {
    const codes = await deps.loadLocationCodes(ctx.targetUserId);
    locCodeToId = new Map(codes.map((c) => [c.code, c.id]));
  }

  const byLocation = new Map<string, string[]>(); // locationId → productIds
  for (const { item, product } of matched) {
    if (!item.locationCode) {
      bump(report, "sem_localizacao_no_arquivo");
      continue;
    }
    const target = locCodeToId?.get(item.locationCode);
    if (!target) {
      bump(report, "local_nao_encontrado");
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `SKU ${item.sku}: localização "${item.locationLabel ?? item.locationCode}" não existe no Dexo — importe as localizações antes`,
      });
      continue;
    }
    if (product.locationId === target) {
      bump(report, "local_ja_correto");
      continue;
    }
    // Produto já tinha OUTRA localização (ex.: corrigida à mão no Dexo): o
    // arquivo é a fonte da importação e vence, mas a sobrescrita fica
    // visível no relatório em vez de silenciosa.
    if (product.locationId) bump(report, "local_sobrescrito");
    const arr = byLocation.get(target) ?? [];
    arr.push(product.id);
    byLocation.set(target, arr);
  }

  const totalLocLinks = Array.from(byLocation.values()).reduce(
    (acc, ids) => acc + ids.length,
    0,
  );
  let locDone = 0;
  for (const [locationId, productIds] of byLocation) {
    if (ctx.dryRun) {
      bump(report, "local_a_vincular", productIds.length);
      locDone += productIds.length;
      continue;
    }
    let capacityBlocked = false;
    for (const part of chunk(productIds, BATCH)) {
      if (capacityBlocked) {
        bump(report, "capacidade_excedida", part.length);
        continue;
      }
      try {
        const res = await deps.attachProducts(
          locationId,
          part,
          ctx.targetUserId,
        );
        bump(report, "local_vinculado", res.attached.length);
        bump(report, "local_ja_correto", res.alreadyAttached.length);
        if (res.skipped.length > 0) {
          bump(report, "erros", res.skipped.length);
          addIssue(report.erros, {
            motivo: `Localização ${res.location.code}: ${res.skipped.length} produto(s) não encontrados no attach`,
          });
        }
      } catch (err) {
        if (err instanceof CapacityExceededError) {
          // Preenche ATÉ O TETO e segue — o attach aborta o batch inteiro,
          // mas o erro informa exatamente quais ids ainda cabem
          // (acceptedIds); os excedentes são reportados e o job nunca aborta.
          capacityBlocked = true;
          const { acceptedIds, excededIds } = err.detail;
          if (acceptedIds.length > 0) {
            try {
              const res = await deps.attachProducts(
                locationId,
                acceptedIds,
                ctx.targetUserId,
              );
              bump(report, "local_vinculado", res.attached.length);
              bump(report, "local_ja_correto", res.alreadyAttached.length);
            } catch {
              // Corrida (outro processo ocupou as vagas): conta como excedido.
              bump(report, "capacidade_excedida", acceptedIds.length);
            }
          }
          bump(report, "capacidade_excedida", excededIds.length);
          bump(report, "avisos");
          addIssue(report.avisos, {
            motivo: `${err.message} — vinculados até o teto; ${excededIds.length} produto(s) ficaram sem vínculo`,
          });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          bump(report, "erros", part.length);
          addIssue(report.erros, {
            motivo: `Falha ao vincular ${part.length} produto(s) à localização: ${msg}`,
          });
        }
      }
      locDone += part.length;
      ctx.onProgress?.({
        fase: "vinculando localizações",
        processadas: locDone,
        total: totalLocLinks,
      });
    }
  }

  /* 3. Vínculo de SUCATA (agrupado por sucata, linkScrapMany ≤200). */
  let scrapKeyToId = maps.scrapKeyToId;
  if (!scrapKeyToId && matched.some(({ item }) => item.scrapKey)) {
    const scraps = await deps.loadExistingScraps(ctx.targetUserId);
    scrapKeyToId = new Map();
    for (const s of scraps) {
      const key = parseVehicleMarker(s.notes) ?? parseScrapWdMarker(s.notes);
      if (key) scrapKeyToId.set(key, s.id);
    }
  }

  const byScrap = new Map<string, string[]>();
  for (const { item, product } of matched) {
    if (!item.scrapKey) {
      bump(report, "sem_sucata_no_arquivo");
      continue;
    }
    const target = scrapKeyToId?.get(item.scrapKey);
    if (!target) {
      bump(report, "sucata_nao_encontrada");
      bump(report, "avisos");
      addIssue(report.avisos, {
        linha: item.linha,
        motivo: `SKU ${item.sku}: sucata de origem #${item.scrapKey} não existe no Dexo — importe as sucatas antes`,
      });
      continue;
    }
    if (product.scrapId === target) {
      bump(report, "sucata_ja_correta");
      continue;
    }
    // Sobrescrita de vínculo divergente visível no relatório (idem local).
    if (product.scrapId) bump(report, "sucata_sobrescrita");
    const arr = byScrap.get(target) ?? [];
    arr.push(product.id);
    byScrap.set(target, arr);
  }

  const totalScrapLinks = Array.from(byScrap.values()).reduce(
    (acc, ids) => acc + ids.length,
    0,
  );
  let scrapDone = 0;
  for (const [scrapId, productIds] of byScrap) {
    if (ctx.dryRun) {
      bump(report, "sucata_a_vincular", productIds.length);
      scrapDone += productIds.length;
      continue;
    }
    for (const part of chunk(productIds, BATCH)) {
      try {
        const res = await deps.linkScrapMany(scrapId, part, ctx.targetUserId);
        bump(report, "sucata_vinculada", res.count);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bump(report, "erros", part.length);
        addIssue(report.erros, {
          motivo: `Falha ao vincular ${part.length} produto(s) à sucata: ${msg}`,
        });
      }
      scrapDone += part.length;
      ctx.onProgress?.({
        fase: "vinculando sucatas",
        processadas: scrapDone,
        total: totalScrapLinks,
      });
    }
  }
}

function applyMapCounters(report: ImportReport, mapped: LinksMapResult): void {
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "linhas_invalidas", mapped.invalidRows);
  bump(report, "sku_duplicado_na_planilha", mapped.duplicateSkuInSheet);
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
}

export interface LinksRunnerDeps {
  links: LinksExecDeps;
  locations: LocationExecDeps;
  scraps: ScrapsExecDeps;
}

export const defaultLinksRunnerDeps: LinksRunnerDeps = {
  links: defaultLinksDeps,
  locations: defaultLocationDeps,
  scraps: defaultScrapsDeps,
};

/**
 * Runner VAAPT/VINCULOS — composto: garante as localizações do próprio
 * arquivo-ponte (idempotente), cria sucatas se o arquivo de veículos veio
 * junto, e então vincula por SKU. Relatório por fase em `porFase`.
 */
export async function runVaaptLinks(
  ctx: ImportContext,
  deps: LinksRunnerDeps = defaultLinksRunnerDeps,
): Promise<ImportReport> {
  const pecas = fileOfKind(ctx.files, "VAAPT_PECAS");
  if (!pecas) {
    throw new ImportValidationError(
      "Arquivo de peças/localização (Vaapt) não encontrado.",
    );
  }
  const report = newReport("VAAPT", "VINCULOS", ctx.targetUserId, ctx.dryRun);
  report.porFase = {};

  // Fase 1 — localizações (do próprio arquivo-ponte; idempotente).
  const locReport = newReport("VAAPT", "VINCULOS", ctx.targetUserId, ctx.dryRun);
  const locMapped = mapVaaptLocations(pecas);
  bump(locReport, "localizacoes_distintas", locMapped.items.length);
  const locCodeToId = await executeLocationPlan(
    ctx,
    locReport,
    locMapped.items,
    deps.locations,
  );
  report.porFase["localizacoes"] = locReport;

  // Fase 2 — sucatas (só se o arquivo de veículos veio junto).
  let scrapKeyToId: Map<string, string> | undefined;
  const veiculos = fileOfKind(ctx.files, "VAAPT_VEICULOS");
  if (veiculos) {
    const scrapReport = newReport(
      "VAAPT",
      "VINCULOS",
      ctx.targetUserId,
      ctx.dryRun,
    );
    const scrapMapped = mapVaaptScraps(veiculos);
    bump(scrapReport, "linhas_no_arquivo", scrapMapped.totalRows);
    bump(scrapReport, "linhas_invalidas", scrapMapped.invalidRows);
    if (scrapMapped.duplicateRows) {
      bump(scrapReport, "linhas_repetidas_mesmo_veiculo", scrapMapped.duplicateRows);
    }
    for (const aviso of scrapMapped.avisos) {
      bump(scrapReport, "avisos");
      addIssue(scrapReport.avisos, aviso);
    }
    scrapKeyToId = await executeScrapsPlan(
      ctx,
      scrapReport,
      scrapMapped.items,
      deps.scraps,
    );
    report.porFase["sucatas"] = scrapReport;
  }

  // Fase 3 — vínculo por SKU.
  const linksReport = newReport(
    "VAAPT",
    "VINCULOS",
    ctx.targetUserId,
    ctx.dryRun,
  );
  const mapped = mapVaaptLinks(pecas);
  applyMapCounters(linksReport, mapped);
  await executeLinksPlan(
    ctx,
    linksReport,
    mapped.items,
    { locCodeToId, scrapKeyToId },
    deps.links,
  );
  report.porFase["vinculos"] = linksReport;

  // Destaques sobem para o topo (a UI mostra sem_produto/ambiguos de cara).
  report.semProduto = linksReport.semProduto;
  report.ambiguos = linksReport.ambiguos;
  bump(report, "produtos_casados", linksReport.contadores.produtos_casados ?? 0);
  bump(report, "erros", linksReport.contadores.erros ?? 0);
  return report;
}

/**
 * Runner WEBDESMONTE/VINCULOS — products.csv + locations.csv (obrigatório
 * para resolver os GUIDs) + purchase_waste.csv opcional.
 */
export async function runWdLinks(
  ctx: ImportContext,
  deps: LinksRunnerDeps = defaultLinksRunnerDeps,
): Promise<ImportReport> {
  const products = fileOfKind(ctx.files, "WD_PRODUCTS");
  const locations = fileOfKind(ctx.files, "WD_LOCATIONS");
  if (!products || !locations) {
    throw new ImportValidationError(
      "Envie products.csv e locations.csv juntos para o vínculo WebDesmonte.",
    );
  }
  const report = newReport(
    "WEBDESMONTE",
    "VINCULOS",
    ctx.targetUserId,
    ctx.dryRun,
  );
  report.porFase = {};

  // Fase 1 — localizações (árvore; idempotente).
  const locReport = newReport(
    "WEBDESMONTE",
    "VINCULOS",
    ctx.targetUserId,
    ctx.dryRun,
  );
  const locMapped = mapWdLocations(locations);
  bump(locReport, "localizacoes_distintas", locMapped.items.length);
  for (const aviso of locMapped.avisos) {
    bump(locReport, "avisos");
    addIssue(locReport.avisos, aviso);
  }
  const locCodeToId = await executeLocationPlan(
    ctx,
    locReport,
    locMapped.items,
    deps.locations,
  );
  report.porFase["localizacoes"] = locReport;

  // Fase 2 — sucatas (opcional).
  let scrapKeyToId: Map<string, string> | undefined;
  const waste = fileOfKind(ctx.files, "WD_PURCHASE_WASTE");
  if (waste) {
    const scrapReport = newReport(
      "WEBDESMONTE",
      "VINCULOS",
      ctx.targetUserId,
      ctx.dryRun,
    );
    const scrapMapped = mapWdScraps(waste, locMapped.guidToCode);
    for (const aviso of scrapMapped.avisos) {
      bump(scrapReport, "avisos");
      addIssue(scrapReport.avisos, aviso);
    }
    scrapKeyToId = await executeScrapsPlan(
      ctx,
      scrapReport,
      scrapMapped.items,
      deps.scraps,
      locCodeToId,
    );
    report.porFase["sucatas"] = scrapReport;
  }

  // Fase 3 — vínculo por SKU (GUIDs resolvidos pelo mapa do locations.csv).
  const linksReport = newReport(
    "WEBDESMONTE",
    "VINCULOS",
    ctx.targetUserId,
    ctx.dryRun,
  );
  const mapped = mapWdLinks(products, locMapped.guidToCode);
  applyMapCounters(linksReport, mapped);
  await executeLinksPlan(
    ctx,
    linksReport,
    mapped.items,
    { locCodeToId, scrapKeyToId },
    deps.links,
  );
  report.porFase["vinculos"] = linksReport;

  report.semProduto = linksReport.semProduto;
  report.ambiguos = linksReport.ambiguos;
  bump(report, "produtos_casados", linksReport.contadores.produtos_casados ?? 0);
  bump(report, "erros", linksReport.contadores.erros ?? 0);
  return report;
}
