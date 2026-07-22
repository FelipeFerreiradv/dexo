/**
 * Casamento de linhas do arquivo com produtos JÁ existentes, por
 * `skuNormalized` — extraído de `product-links.executor.ts` para ser reusado
 * por qualquer importação que precise achar o produto pelo SKU (vínculo de
 * localização/sucata, fotos, …) sem repetir as regras à prova de erro:
 *
 * - SKU sem produto ⇒ `sem_produto` (pula e reporta; NUNCA vincula em outro);
 * - SKU que casa MAIS de um produto (normalizado igual) ⇒ `ambiguos`, nunca
 *   vincula;
 * - duas linhas com SKUs CRUS distintos que normalizam igual ("X10"/"x10")
 *   casariam o MESMO produto: só a 1ª vale (determinístico) e as demais são
 *   contadas e avisadas.
 *
 * O preload é feito em chunks (zero query por linha).
 */

import { normalizeSku } from "../../../lib/sku";
import type { ImportContext, ImportReport } from "../import.types";
import { MAX_EXAMPLES, addIssue, bump } from "../import.types";
import { chunk } from "./normalize";

const PRELOAD_CHUNK = 500;

/** Qualquer item de plano que traga um SKU cru e a linha de origem. */
export interface SkuKeyedItem {
  linha: number;
  sku: string;
}

/** Qualquer produto pré-carregado que traga o SKU normalizado. */
export interface SkuMatchableProduct {
  id: string;
  skuNormalized: string | null;
}

export interface SkuMatch<I, P> {
  item: I;
  product: P;
}

/**
 * Casa os itens com os produtos do tenant e ALIMENTA O RELATÓRIO com os
 * contadores/listas padrão (`produtos_casados`, `sem_produto`, `sku_ambiguo`,
 * `linhas_extras_mesmo_sku`, `report.semProduto`, `report.ambiguos`).
 *
 * `loadBySkuNormalized` recebe UM chunk de skus normalizados — o chunking e o
 * progresso ficam aqui.
 */
export async function matchItemsBySku<
  I extends SkuKeyedItem,
  P extends SkuMatchableProduct,
>(
  ctx: ImportContext,
  report: ImportReport,
  items: I[],
  loadBySkuNormalized: (userId: string, skusNormalized: string[]) => Promise<P[]>,
): Promise<Array<SkuMatch<I, P>>> {
  const normToItems = new Map<string, I[]>();
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
  const bySkuNorm = new Map<string, P[]>();
  let preloaded = 0;
  for (const part of chunk(allNorms, PRELOAD_CHUNK)) {
    const refs = await loadBySkuNormalized(ctx.targetUserId, part);
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
  const matched: Array<SkuMatch<I, P>> = [];

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

  return matched;
}
