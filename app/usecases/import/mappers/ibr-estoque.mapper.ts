/**
 * Estoque do IBR (export tabular "IBR-4243", estoque.csv). Cada linha é um
 * produto com SKU, dados comerciais e a localização em TEXTO hierárquico
 * (`LocalizacaoSiglas`, ex.: "BARR. > CORR.-B > PRT.-56 > CXA 07" — mesma
 * convenção `>` do WebDesmonte). Produz:
 *   - `produtos`: itens para casar por SKU (vincular localização ao produto
 *     existente) e criar os que faltam;
 *   - `locationItems`: a ÁRVORE de localizações derivada dos caminhos (pais
 *     antes dos filhos), no formato do executor de localizações.
 *
 * A localização é o `LocalizacaoSiglas` (não o `LocalizacaoDescricao`, que
 * colapsa prateleiras distintas no genérico "Prateleira"). O `LocationId`
 * (GUID) do arquivo é ignorado — sem `locations.csv` não há como resolvê-lo,
 * e o texto do caminho é a fonte.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import { cumulativePaths, normPath } from "../lib/codes";
import { asNumber, asString } from "../lib/normalize";
import type { LocationPlanItem } from "../executors/locations.executor";

export interface EstoquePlanItem {
  linha: number;
  sku: string;
  name: string;
  price: number;
  /** Custo real (> 0.01); placeholder 0.01/0 vira null. */
  cost: number | null;
  stock: number;
  brand: string | null;
  model: string | null;
  ncm: string | null;
  barcode: string | null;
  active: boolean;
  /** id interno do IBR (auditoria / marker). */
  ibrProductId: string | null;
  /** Code (caminho normalizado) da localização-folha; null se sem localização. */
  locationCode: string | null;
  /** Texto do caminho (para gravar em Product.location no create). */
  locationText: string | null;
}

export interface EstoqueMapResult {
  produtos: EstoquePlanItem[];
  /** Árvore de localizações (pais antes dos filhos), deduplicada. */
  locationItems: LocationPlanItem[];
  totalRows: number;
  semSku: number;
  duplicadosSku: number;
  avisos: ImportRowIssue[];
}

/** Estoque: inteiro ≥ 0 (negativos/inválidos → 0). */
function asStock(v: unknown): number {
  const n = asNumber(v);
  if (n === null) return 0;
  return Math.max(0, Math.floor(n));
}

/** Custo real: só aceita > 0.01 (o IBR usa 0.01/0 como placeholder). */
function asCost(real: unknown, atual: unknown): number | null {
  for (const raw of [real, atual]) {
    const n = asNumber(raw);
    if (n !== null && n > 0.01) return n;
  }
  return null;
}

export function mapIbrEstoque(file: DetectedFile): EstoqueMapResult {
  const produtos: EstoquePlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenSku = new Set<string>();
  let semSku = 0;
  let duplicadosSku = 0;

  // Árvore de localizações: caminhos cumulativos distintos, com parentCode.
  const locByCode = new Map<string, LocationPlanItem>();

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const skuRaw = asString(get("SKU"));
    // SKU inválido do IBR: "-1" (produto sem código) ou vazio.
    if (!skuRaw || skuRaw === "-1") {
      semSku++;
      continue;
    }
    // Dedup intra-arquivo por SKU (case/espaço-insensível): 1ª ocorrência vence.
    const skuKey = skuRaw.trim().toLowerCase();
    if (seenSku.has(skuKey)) {
      duplicadosSku++;
      continue;
    }
    seenSku.add(skuKey);

    // Localização (texto hierárquico) → code normalizado + árvore.
    const rawLoc = asString(get("LocalizacaoSiglas"));
    let locationCode: string | null = null;
    let locationText: string | null = null;
    if (rawLoc) {
      const full = normPath(rawLoc);
      if (full) {
        locationCode = full;
        locationText = full;
        // Registra cada nó cumulativo do caminho, com o pai encadeado.
        const paths = cumulativePaths(full);
        for (let d = 0; d < paths.length; d++) {
          const code = paths[d];
          if (!locByCode.has(code)) {
            locByCode.set(code, {
              code,
              description: code,
              maxCapacity: 0,
              parentCode: d > 0 ? paths[d - 1] : null,
              linha,
            });
          }
        }
      }
    }

    produtos.push({
      linha,
      sku: skuRaw.trim(),
      name: asString(get("Description")) ?? "(sem descrição)",
      price: asNumber(get("ValorVenda")) ?? 0,
      cost: asCost(get("CustoReal"), get("CustoAtual")),
      stock: asStock(get("QuantidadeEstoque")),
      brand: asString(get("Brand")),
      model: asString(get("Model")),
      ncm: asString(get("Ncm")),
      barcode: asString(get("BarCode")),
      active: (asString(get("Active")) ?? "").toLowerCase() === "t",
      ibrProductId: asString(get("ProductId")),
      locationCode,
      locationText,
    });
  }

  // Ordena a árvore por profundidade (pais antes dos filhos), como exige o
  // executor de localizações.
  const locationItems = Array.from(locByCode.values()).sort(
    (a, b) => cumulativePaths(a.code).length - cumulativePaths(b.code).length,
  );

  if (semSku > 0) {
    addIssue(avisos, {
      motivo: `${semSku} linha(s) sem SKU válido (código "-1" ou vazio) foram ignoradas`,
    });
  }

  return {
    produtos,
    locationItems,
    totalRows: file.rows.length,
    semSku,
    duplicadosSku,
    avisos,
  };
}
