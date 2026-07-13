/**
 * Executor de ESTOQUE IBR (estoque.csv). Faz, em ordem, na MESMA execução:
 *   1. cria a árvore de localizações derivada dos caminhos em texto
 *      (`executeLocationPlan`, pais antes de filhos, idempotente);
 *   2. casa cada linha por `skuNormalized` (nunca `findBySku` cru) contra os
 *      produtos que JÁ existem no tenant;
 *   3. para o produto existente → vincula a localização (`attachProducts`);
 *   4. para o produto que NÃO existe → cria via `ProductUseCase.create`, já
 *      com a localização (decisão do Felipe: criar os faltantes).
 *
 * Anti-duplicação: casamento por `skuNormalized` + unique `(userId, sku)` +
 * P2002 tratado como "já existe → vincula". Reimportar não duplica: na 2ª
 * rodada o produto criado antes casa por SKU e só o vínculo é reconferido.
 * A PRÉVIA (dryRun) não escreve nada e mostra criar/vincular/já-correto.
 */

import prisma from "../../../lib/prisma";
import { normalizeSku } from "../../../lib/sku";
import { LocationUseCase } from "../../location.usercase";
import { ProductUseCase } from "../../product.usercase";
import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  addSample,
  bump,
  newReport,
} from "../import.types";
import { chunk } from "../lib/normalize";
import { fileOfKind } from "../import-detector";
import { mapIbrEstoque, type EstoquePlanItem } from "../mappers/ibr-estoque.mapper";
import {
  executeLocationPlan,
  defaultLocationDeps,
  type LocationExecDeps,
} from "./locations.executor";

interface ExistingProductRef {
  id: string;
  sku: string;
  skuNormalized: string | null;
  locationId: string | null;
}

export interface IbrEstoqueDeps {
  locations: LocationExecDeps;
  productUseCase: Pick<ProductUseCase, "create">;
  loadProductsBySkuNormalized: (
    userId: string,
    skusNormalized: string[],
  ) => Promise<ExistingProductRef[]>;
  attachProducts: LocationUseCase["attachProducts"];
}

const locationUseCase = new LocationUseCase();
const productUseCase = new ProductUseCase();

export const defaultIbrEstoqueDeps: IbrEstoqueDeps = {
  locations: defaultLocationDeps,
  productUseCase,
  loadProductsBySkuNormalized: async (userId, skusNormalized) => {
    const byNorm = await prisma.product.findMany({
      where: { userId, skuNormalized: { in: skusNormalized } },
      select: { id: true, sku: true, skuNormalized: true, locationId: true },
    });
    // ANTI-DUPLICAÇÃO: produtos LEGADOS com skuNormalized NULL (coluna
    // adicionada via SQL, backfill não rodado para o tenant) nunca casam num
    // `IN` sobre skuNormalized. Sem isto, o executor os trataria como
    // "faltantes" e CRIARIA um 2º produto para o mesmo SKU (o unique
    // (userId, sku) é case-sensitive). Carrega-os para o casamento indexá-los
    // por normalizeSku(sku) — num tenant com backfill esta query volta vazia.
    const legacy = await prisma.product.findMany({
      where: { userId, skuNormalized: null },
      select: { id: true, sku: true, skuNormalized: true, locationId: true },
    });
    return [...byNorm, ...legacy];
  },
  attachProducts: locationUseCase.attachProducts.bind(locationUseCase),
};

const BATCH = 200; // limite hard do attachProducts
const PRELOAD_CHUNK = 500;

/** Runner IBR/ESTOQUE. */
export async function runIbrEstoque(
  ctx: ImportContext,
  deps: IbrEstoqueDeps = defaultIbrEstoqueDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "IBR_ESTOQUE");
  if (!file) {
    throw new ImportValidationError("Arquivo de estoque (IBR) não encontrado.");
  }
  const report = newReport("IBR", "ESTOQUE", ctx.targetUserId, ctx.dryRun);
  report.porFase = {};
  const mapped = mapIbrEstoque(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "produtos_validos", mapped.produtos.length);
  bump(report, "sem_sku", mapped.semSku);
  bump(report, "sku_duplicado_no_arquivo", mapped.duplicadosSku);
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }

  /* Fase 1 — localizações (árvore do próprio arquivo; idempotente). */
  const locReport = newReport("IBR", "ESTOQUE", ctx.targetUserId, ctx.dryRun);
  bump(locReport, "localizacoes_distintas", mapped.locationItems.length);
  const codeToId = await executeLocationPlan(
    ctx,
    locReport,
    mapped.locationItems,
    deps.locations,
  );
  report.porFase["localizacoes"] = locReport;

  /* Fase 2 — produtos (casar por SKU → vincular existentes / criar faltantes). */
  const prodReport = newReport("IBR", "ESTOQUE", ctx.targetUserId, ctx.dryRun);
  await executeEstoqueProdutos(ctx, prodReport, mapped.produtos, codeToId, deps);
  report.porFase["produtos"] = prodReport;

  // Roll-up dos destaques para o topo.
  bump(report, "produtos_criados", prodReport.contadores.produtos_criados ?? 0);
  bump(report, "produtos_vinculados", prodReport.contadores.produtos_casados ?? 0);
  bump(report, "erros", (locReport.contadores.erros ?? 0) + (prodReport.contadores.erros ?? 0));
  return report;
}

async function executeEstoqueProdutos(
  ctx: ImportContext,
  report: ImportReport,
  produtos: EstoquePlanItem[],
  codeToId: Map<string, string>,
  deps: IbrEstoqueDeps,
): Promise<void> {
  bump(report, "linhas", produtos.length);

  /* 1. Preload dos produtos existentes por skuNormalized (chunks em lote). */
  const normToItem = new Map<string, EstoquePlanItem>();
  for (const p of produtos) {
    const norm = normalizeSku(p.sku);
    if (!norm) {
      bump(report, "erros");
      addIssue(report.erros, { linha: p.linha, motivo: "SKU vazio" });
      continue;
    }
    // Dedup já garantido no mapper; se colidir, a 1ª vence.
    if (!normToItem.has(norm)) normToItem.set(norm, p);
  }
  const allNorms = Array.from(normToItem.keys());
  const bySkuNorm = new Map<string, ExistingProductRef[]>();
  const seenProductIds = new Set<string>(); // legados repetem entre chunks
  let preloaded = 0;
  for (const part of chunk(allNorms, PRELOAD_CHUNK)) {
    const refs = await deps.loadProductsBySkuNormalized(ctx.targetUserId, part);
    for (const ref of refs) {
      // Indexa por skuNormalized do banco quando existe; para o legado com
      // skuNormalized NULL, deriva de normalizeSku(sku) — a MESMA chave que o
      // item do arquivo usa. Assim o legado casa e é vinculado (não recriado).
      const key = ref.skuNormalized ?? normalizeSku(ref.sku);
      if (!key) continue;
      if (seenProductIds.has(ref.id)) continue;
      seenProductIds.add(ref.id);
      const arr = bySkuNorm.get(key) ?? [];
      arr.push(ref);
      bySkuNorm.set(key, arr);
    }
    preloaded += part.length;
    ctx.onProgress?.({
      fase: "casando produtos por SKU",
      processadas: preloaded,
      total: allNorms.length,
    });
  }

  /* 2. Resolve o destino de localização e separa vincular vs criar. */
  const byLocation = new Map<string, string[]>(); // locationId → productIds (existentes)
  const aCriar: Array<{ item: EstoquePlanItem; locationId: string | null }> = [];

  for (const [norm, item] of normToItem) {
    // Destino de localização. No APPLY o id é sempre real; na PRÉVIA, uma
    // localização a ser criada tem id placeholder "<dry-...>".
    const resolved = item.locationCode
      ? (codeToId.get(item.locationCode) ?? null)
      : null;
    const isDry = !!resolved && resolved.startsWith("<dry-");
    const locationId = resolved && !isDry ? resolved : null; // real (apply / loc já existente)
    if (!item.locationCode) bump(report, "sem_localizacao_no_arquivo");

    const refs = bySkuNorm.get(norm) ?? [];
    if (refs.length > 1) {
      bump(report, "sku_ambiguo");
      bump(report, "avisos");
      addIssue(report.avisos, {
        linha: item.linha,
        motivo: `SKU "${item.sku}" casa ${refs.length} produtos no Dexo — não vinculado (revise manualmente)`,
      });
      continue;
    }

    if (refs.length === 1) {
      // Produto JÁ existe → só vincula a localização (nunca recria).
      bump(report, "produtos_casados");
      const product = refs[0];
      if (!resolved) continue; // sem localização no arquivo → nada a fazer

      if (ctx.dryRun) {
        // Prévia: destino novo (dry) é sempre uma mudança; destino existente
        // compara com a localização atual do produto. Conta a sobrescrita
        // AQUI para a prévia refletir exatamente o que o apply fará.
        if (isDry || product.locationId !== resolved) {
          bump(report, "local_a_vincular");
          if (product.locationId) bump(report, "local_sobrescrito");
        } else {
          bump(report, "local_ja_correto");
        }
        continue;
      }
      // Apply: locationId é sempre real.
      if (product.locationId === locationId) {
        bump(report, "local_ja_correto");
        continue;
      }
      if (product.locationId) bump(report, "local_sobrescrito");
      const arr = byLocation.get(locationId!) ?? [];
      arr.push(product.id);
      byLocation.set(locationId!, arr);
    } else {
      // Produto NÃO existe → cria (com a localização, quando resolvida no apply).
      aCriar.push({ item, locationId });
    }
  }

  bump(report, "a_criar", aCriar.length);

  /* 3. Vínculo dos EXISTENTES (attachProducts, chunks ≤200, serial). */
  const totalLoc = Array.from(byLocation.values()).reduce((a, ids) => a + ids.length, 0);
  let locDone = 0;
  for (const [locationId, productIds] of byLocation) {
    if (ctx.dryRun) {
      bump(report, "local_a_vincular", productIds.length);
      locDone += productIds.length;
      continue;
    }
    for (const partIds of chunk(productIds, BATCH)) {
      try {
        const res = await deps.attachProducts(locationId, partIds, ctx.targetUserId);
        bump(report, "local_vinculado", res.attached.length);
        bump(report, "local_ja_correto", res.alreadyAttached.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bump(report, "erros", partIds.length);
        addIssue(report.erros, {
          motivo: `Falha ao vincular ${partIds.length} produto(s) à localização: ${msg}`,
        });
      }
      locDone += partIds.length;
      ctx.onProgress?.({ fase: "vinculando localizações", processadas: locDone, total: totalLoc });
    }
  }

  /* 4. Criação dos FALTANTES (via ProductUseCase.create, serial). */
  let criados = 0;
  for (let idx = 0; idx < aCriar.length; idx++) {
    const { item, locationId } = aCriar[idx];
    if (idx % 100 === 0 || idx === aCriar.length - 1) {
      ctx.onProgress?.({ fase: "criando produtos", processadas: idx + 1, total: aCriar.length });
    }
    if (ctx.dryRun) {
      addSample(report, {
        sku: item.sku,
        nome: item.name,
        preco: item.price,
        estoque: item.stock,
        localizacao: item.locationText ?? null,
      });
      continue;
    }
    try {
      await deps.productUseCase.create({
        userId: ctx.targetUserId,
        sku: item.sku,
        name: item.name,
        price: item.price,
        stock: item.stock,
        costPrice: item.cost ?? undefined,
        brand: item.brand ?? undefined,
        model: item.model ?? undefined,
        quality: "SEMINOVO",
        imageUrl: "",
        // Localização já no create (o texto é o próprio caminho da árvore).
        ...(locationId
          ? { locationId, location: item.locationText ?? undefined }
          : {}),
        attributes: {
          migration: { value_name: "IBR" },
          ibrProductId: { value_name: item.ibrProductId ?? "" },
          ncm: { value_name: item.ncm ?? "" },
          barcode: { value_name: item.barcode ?? "" },
        },
      });
      bump(report, "produtos_criados");
      criados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Backstop de última linha: o SKU passou a existir entre o preload e o
      // create (corrida real) → NÃO duplica (o unique/findBySku barrou),
      // conta como já-existente. Os legados sem skuNormalized já são casados
      // no preload acima, então este ramo é raro.
      if (/já existe/i.test(msg) || /unique/i.test(msg)) {
        bump(report, "ja_existiam_corrida");
        continue;
      }
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Produto SKU ${item.sku}: ${msg}`,
      });
    }
  }
  bump(report, "produtos_criados_total", criados);
}
