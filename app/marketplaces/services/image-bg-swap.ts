/**
 * Swap de referências de imagem (recorte assíncrono, PR 4).
 *
 * Quando o worker conclui um recorte, o produto pode JÁ ter sido salvo com a
 * URL da WebP otimizada (decisão do Felipe: salvar nunca espera o recorte).
 * Este módulo troca a URL antiga pela nova em TODOS os lugares que guardam
 * URLs de imagem, de forma idempotente e escopada pelo tenant:
 *
 *  - Product.imageUrl   (updateMany simples)
 *  - Product.imageUrls  (String[] — array_replace via SQL cru; Prisma não
 *                        tem update de elemento de lista escalar)
 *  - Scrap.imageUrls    (idem)
 *  - ProductListing.imageUrlsOverride (Json — read-modify-write best-effort,
 *                        escopado via Product.userId)
 *
 * NUNCA passa por ProductUseCase.update: aquele caminho dispara sync de
 * anúncio nos marketplaces — trocar a foto local não pode republicar nada.
 *
 * Idempotente por construção (WHERE pela URL antiga): rodar de novo depois
 * que nada mais referencia a URL antiga é no-op — é o que permite as
 * varreduras extras (+2min/+10min) cobrirem a corrida save-vs-complete.
 */

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";

export interface SwapCounts {
  productImageUrl: number;
  productImageUrls: number;
  scrapImageUrls: number;
  listingOverrides: number;
}

export async function swapImageUrlReferences(input: {
  userId: string;
  oldUrl: string;
  newUrl: string;
  /** Override para testes. */
  db?: typeof prisma;
}): Promise<SwapCounts> {
  const db = input.db ?? prisma;
  const { userId, oldUrl, newUrl } = input;

  const productImageUrl = (
    await db.product.updateMany({
      where: { userId, imageUrl: oldUrl },
      data: { imageUrl: newUrl },
    })
  ).count;

  const productImageUrls = await db.$executeRaw`
    UPDATE "Product"
       SET "imageUrls" = array_replace("imageUrls", ${oldUrl}, ${newUrl})
     WHERE "userId" = ${userId}
       AND ${oldUrl} = ANY("imageUrls")`;

  const scrapImageUrls = await db.$executeRaw`
    UPDATE "Scrap"
       SET "imageUrls" = array_replace("imageUrls", ${oldUrl}, ${newUrl})
     WHERE "userId" = ${userId}
       AND ${oldUrl} = ANY("imageUrls")`;

  // Overrides por anúncio (Json): raros e pequenos — read-modify-write.
  // Escopo de tenant via o produto dono do listing.
  let listingOverrides = 0;
  const listings = await db.productListing.findMany({
    where: {
      product: { userId },
      // Filtro grosso no banco (só quem tem override); refinamento em JS.
      imageUrlsOverride: { not: Prisma.DbNull },
    },
    select: { id: true, imageUrlsOverride: true },
  });
  for (const l of listings) {
    const arr = l.imageUrlsOverride;
    if (!Array.isArray(arr) || !arr.includes(oldUrl)) continue;
    const next = arr.map((u) => (u === oldUrl ? newUrl : u));
    await db.productListing.update({
      where: { id: l.id },
      data: { imageUrlsOverride: next },
    });
    listingOverrides += 1;
  }

  return { productImageUrl, productImageUrls, scrapImageUrls, listingOverrides };
}
