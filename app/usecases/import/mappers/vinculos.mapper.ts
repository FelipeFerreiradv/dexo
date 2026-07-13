/**
 * Vínculo de produtos por SKU — mapeadores dos DOIS arquivos-ponte:
 *
 * - Vaapt: planilha de peças ("# Cod Peca" = SKU, "Localizacao" texto plano,
 *   "Cod Veiculo" = FK da sucata).
 * - WebDesmonte: products.csv ("Code" = SKU, "LocationId"/"PurchaseWasteId"
 *   GUIDs resolvidos pelos mapas de locations.csv/purchase_waste.csv).
 *
 * O mapper NÃO decide nada sobre o banco — só normaliza a intenção de cada
 * linha (SKU cru + destino de localização/sucata). O casamento com o produto
 * real acontece no executor, por `skuNormalized`.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import { normalizeCodeFlat } from "../lib/codes";
import { asString } from "../lib/normalize";

export interface LinkPlanItem {
  linha: number;
  /** SKU cru do arquivo (o executor casa por normalizeSku). */
  sku: string;
  /** Code da localização destino (convenção do sistema de origem). */
  locationCode?: string | null;
  /** Texto original da localização (relatório/descrição). */
  locationLabel?: string | null;
  /** Chave da sucata destino (cod Vaapt / GUID WebDesmonte). */
  scrapKey?: string | null;
}

export interface LinksMapResult {
  items: LinkPlanItem[];
  totalRows: number;
  invalidRows: number;
  duplicateSkuInSheet: number;
  avisos: ImportRowIssue[];
}

export function mapVaaptLinks(file: DetectedFile): LinksMapResult {
  const items: LinkPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenSku = new Set<string>();
  let invalidRows = 0;
  let duplicateSkuInSheet = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const sku = asString(get("# Cod Peca"));
    if (!sku) {
      invalidRows++;
      continue;
    }
    if (seenSku.has(sku)) {
      duplicateSkuInSheet++;
      continue; // 1ª ocorrência vence (determinístico, igual aos scripts)
    }
    seenSku.add(sku);

    const rawLoc = asString(get("Localizacao"));
    items.push({
      linha,
      sku,
      locationCode: normalizeCodeFlat(rawLoc),
      locationLabel: rawLoc,
      scrapKey: asString(get("Cod Veiculo")),
    });
  }

  return {
    items,
    totalRows: file.rows.length,
    invalidRows,
    duplicateSkuInSheet,
    avisos,
  };
}

export function mapWdLinks(
  file: DetectedFile,
  /** GUID→code das localizações (obrigatório: vem de locations.csv). */
  locationGuidToCode: Map<string, string>,
): LinksMapResult {
  const items: LinkPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenSku = new Set<string>();
  let invalidRows = 0;
  let duplicateSkuInSheet = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const code = asString(get("Code"));
    const wdId = asString(get("Id"));
    if (!code) {
      invalidRows++;
      continue;
    }

    // Código duplicado DENTRO do arquivo: o migrador CLI criava o 2º produto
    // como "Code-wdId" — tenta a mesma convenção para ainda casar o produto
    // certo em tenants migrados por script; se não existir, cai em
    // sem_produto (nunca vincula no produto errado).
    let sku = code;
    if (seenSku.has(sku)) {
      if (!wdId) {
        duplicateSkuInSheet++;
        continue;
      }
      sku = `${code}-${wdId}`;
      if (seenSku.has(sku)) {
        duplicateSkuInSheet++;
        continue;
      }
      duplicateSkuInSheet++;
      addIssue(avisos, {
        linha,
        motivo: `Code "${code}" repetido no arquivo — a 2ª ocorrência tenta casar o SKU desambiguado "${sku}"`,
      });
    }
    seenSku.add(sku);

    const locGuid = asString(get("LocationId"));
    const locationCode = locGuid
      ? (locationGuidToCode.get(locGuid) ?? null)
      : null;
    if (locGuid && !locationCode) {
      addIssue(avisos, {
        linha,
        motivo: `SKU ${sku}: LocationId ${locGuid} não existe no locations.csv enviado`,
      });
    }

    items.push({
      linha,
      sku,
      locationCode,
      locationLabel: locationCode,
      scrapKey: asString(get("PurchaseWasteId")),
    });
  }

  return {
    items,
    totalRows: file.rows.length,
    invalidRows,
    duplicateSkuInSheet,
    avisos,
  };
}
