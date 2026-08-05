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
import { aliasReader } from "../lib/columns";

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
  /**
   * Etiqueta física da peça (só o relatório de produtos do Vaapt tem).
   * Segunda chance de casamento quando o `Cod Peça` não existe no Dexo —
   * ver `lib/etiqueta-match.ts`. Ausente nos demais arquivos.
   */
  etiqueta?: string | null;
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

  // Sinônimo da coluna de local, resolvido pelo HEADER: o arquivo-ponte usa
  // "Localizacao" e o relatório de produtos (export novo) usa "Localização
  // Produto". Sem isto, o relatório de produtos entrava com locationCode NULL
  // em TODAS as linhas — a importação dizia sucesso e não vinculava nada.
  //
  // ⚠️ A coluna de VEÍCULO fica de fora de propósito. No relatório de produtos
  // ela é "Código Veículo" e, no export medido, o valor é o literal "DUMMY"
  // com um único código para as 28.910 peças. Aliasá-la produziria 28.910
  // avisos de "sucata de origem não existe no Dexo" sem nenhum ganho.
  const read = aliasReader(file);

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

    const rawLoc = asString(
      read(row, "Localizacao", "Localização Produto", "Localizacao Produto"),
    );
    items.push({
      linha,
      sku,
      locationCode: normalizeCodeFlat(rawLoc),
      locationLabel: rawLoc,
      scrapKey: asString(get("Cod Veiculo")),
      // Só o relatório de produtos tem esta coluna; no arquivo-ponte clássico
      // `read` devolve null e o campo simplesmente não entra em jogo.
      etiqueta: asString(read(row, "Etiqueta")),
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
