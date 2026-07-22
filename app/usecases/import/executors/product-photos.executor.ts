/**
 * FOTOS DAS PEÇAS — casa cada peça do arquivo de imagens ao produto por
 * `skuNormalized` (a mesma chave e as mesmas regras do vínculo, em
 * `lib/sku-match.ts`) e grava as URLs em `imageUrl`/`imageUrls`.
 *
 * Decisões fechadas:
 *
 * 1. NÃO SOBRESCREVE FOTO EXISTENTE. Só produto sem nenhuma imagem recebe as
 *    do arquivo. Quem já tem foto (tirada no Dexo, puxada do anúncio ou
 *    curada à mão) fica intacto, e o relatório conta em `ja_tinha_foto`. É o
 *    mesmo critério da fase 5 de scripts/migracao-vaapt.ts. Efeito colateral
 *    bom: reimportar é idempotente sem precisar de marker.
 * 2. NÃO PUBLICA. A escrita vai por `ProductUseCase.setImageUrlsMany`, que
 *    não dispara sincronização de anúncio — importar povoa o catálogo;
 *    publicar é um ato separado e explícito do operador.
 * 3. A URL é gravada como veio. As imagens seguem servidas pelo host de
 *    origem — mesmo padrão de scripts/backfill-product-images-from-listings.ts
 *    e da fase 5 do migrador. Se aquele host sair do ar, as fotos somem do
 *    Dexo: é uma troca consciente (re-hospedar 69k imagens seria vários GB no
 *    disco da VPS).
 */

import prisma from "../../../lib/prisma";
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
import { matchItemsBySku } from "../lib/sku-match";
import { fileOfKind } from "../import-detector";
import { mapVaaptPhotos } from "../mappers/vaapt-fotos.mapper";
import type { PhotoPlanItem } from "../mappers/vaapt-fotos.mapper";

/** Cap do `setImageUrlsMany` (mesmo do `linkScrapMany`/`attachProducts`). */
const BATCH = 200;

export interface PhotoProductRef {
  id: string;
  sku: string;
  skuNormalized: string | null;
  imageUrl: string | null;
  imageUrls: string[];
}

export interface PhotosExecDeps {
  loadProductsBySkuNormalized: (
    userId: string,
    skusNormalized: string[],
  ) => Promise<PhotoProductRef[]>;
  setImageUrlsMany: ProductUseCase["setImageUrlsMany"];
}

const productUseCase = new ProductUseCase();

export const defaultPhotosDeps: PhotosExecDeps = {
  loadProductsBySkuNormalized: (userId, skusNormalized) =>
    prisma.product.findMany({
      where: { userId, skuNormalized: { in: skusNormalized } },
      select: {
        id: true,
        sku: true,
        skuNormalized: true,
        imageUrl: true,
        imageUrls: true,
      },
    }),
  setImageUrlsMany: productUseCase.setImageUrlsMany.bind(productUseCase),
};

function jaTemFoto(p: PhotoProductRef): boolean {
  if (p.imageUrl && p.imageUrl.trim().length > 0) return true;
  return Array.isArray(p.imageUrls) && p.imageUrls.length > 0;
}

export async function executePhotosPlan(
  ctx: ImportContext,
  report: ImportReport,
  items: PhotoPlanItem[],
  deps: PhotosExecDeps = defaultPhotosDeps,
): Promise<void> {
  bump(report, "pecas_com_foto_no_arquivo", items.length);

  const matched = await matchItemsBySku(
    ctx,
    report,
    items,
    deps.loadProductsBySkuNormalized,
  );

  const aGravar: Array<{
    productId: string;
    imageUrl: string;
    imageUrls: string[];
  }> = [];
  for (const { item, product } of matched) {
    if (jaTemFoto(product)) {
      bump(report, "ja_tinha_foto");
      continue;
    }
    aGravar.push({
      productId: product.id,
      imageUrl: item.urls[0],
      imageUrls: item.urls,
    });
    addSample(report, {
      sku: item.sku,
      fotos: item.urls.length,
      primeira: item.urls[0],
    });
  }

  bump(
    report,
    "fotos_no_plano",
    aGravar.reduce((acc, w) => acc + w.imageUrls.length, 0),
  );

  if (ctx.dryRun) {
    bump(report, "produtos_a_receber_foto", aGravar.length);
    ctx.onProgress?.({
      fase: "fotos",
      processadas: aGravar.length,
      total: aGravar.length,
    });
    return;
  }

  let processadas = 0;
  for (const part of chunk(aGravar, BATCH)) {
    try {
      const res = await deps.setImageUrlsMany(part, ctx.targetUserId);
      bump(report, "produtos_com_foto_gravada", res.count);
      // O updateMany é escopado por userId: um id que não pertence ao tenant
      // simplesmente não é afetado. Reporta em vez de falhar em silêncio.
      if (res.count < part.length) {
        bump(report, "produtos_nao_afetados", part.length - res.count);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bump(report, "erros", part.length);
      addIssue(report.erros, {
        motivo: `Falha ao gravar fotos de ${part.length} produto(s): ${msg}`,
      });
    }
    processadas += part.length;
    ctx.onProgress?.({
      fase: "gravando fotos",
      processadas,
      total: aGravar.length,
    });
  }
}

/** Runner VAAPT/FOTOS — recebe só o arquivo de imagens das peças. */
export async function runVaaptPhotos(
  ctx: ImportContext,
  deps: PhotosExecDeps = defaultPhotosDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "VAAPT_PECAS_IMAGENS");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo de fotos das peças (Vaapt) não encontrado.",
    );
  }
  const report = newReport("VAAPT", "FOTOS", ctx.targetUserId, ctx.dryRun);
  const mapped = mapVaaptPhotos(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "linhas_invalidas", mapped.invalidRows);
  if (mapped.urlsInvalidas) {
    bump(report, "links_invalidos", mapped.urlsInvalidas);
  }
  if (mapped.urlsDuplicadas) {
    bump(report, "links_repetidos", mapped.urlsDuplicadas);
  }
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
  await executePhotosPlan(ctx, report, mapped.items, deps);
  return report;
}
