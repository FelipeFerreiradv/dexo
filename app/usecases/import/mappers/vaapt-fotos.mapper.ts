/**
 * Fotos das peças (Vaapt) — "BackupImagesPecasEmp<N>.xlsx": UMA LINHA POR
 * FOTO, com a peça repetida. O mapper agrupa por peça e devolve a lista de
 * URLs na ordem do arquivo.
 *
 * Chave de casamento: `# idPeca`. É EXATAMENTE o mesmo valor que
 * `mapVaaptLinks` usa como SKU (`# Cod Peca` da planilha de peças) — medido
 * nos arquivos reais do cliente: 13.648 de 13.648 batem. As colunas `SKU` e
 * `Codigo ML` do próprio arquivo NÃO servem: `SKU` traz o sentinela
 * "EXCLUIDO" em 17.742 das 69.931 linhas.
 *
 * As URLs são gravadas COMO ESTÃO (o host de origem continua servindo a
 * imagem) — mesmo padrão da fase 5 de scripts/migracao-vaapt.ts e de
 * scripts/backfill-product-images-from-listings.ts, que guardam a URL do
 * anúncio. Só http/https passam: `imageUrl` é renderizado no app e enviado
 * aos marketplaces, então um `javascript:`/`data:` vindo da planilha não pode
 * entrar.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import { asString } from "../lib/normalize";
import { aliasReader } from "../lib/columns";

/**
 * Teto defensivo por peça. O maior caso real tem 32 fotos e os marketplaces
 * já cortam no envio (ML 12, Shopee 9, Magalu por constante) — isto existe só
 * para uma planilha patológica não gerar um array gigante no produto.
 */
export const MAX_FOTOS_POR_PECA = 50;

export interface PhotoPlanItem {
  /** 1ª linha em que a peça aparece (para o relatório). */
  linha: number;
  /** `# idPeca` — casa com Product.skuNormalized, igual ao vínculo. */
  sku: string;
  /** URLs http(s), na ordem do arquivo, sem repetição. */
  urls: string[];
}

export interface PhotosMapResult {
  items: PhotoPlanItem[];
  totalRows: number;
  /** Linhas sem `# idPeca` — não dá para saber de que peça é a foto. */
  invalidRows: number;
  /** Linhas cuja URL é vazia ou de esquema não permitido. */
  urlsInvalidas: number;
  /** Linhas que repetem uma URL já vista NA MESMA peça. */
  urlsDuplicadas: number;
  avisos: ImportRowIssue[];
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function mapVaaptPhotos(file: DetectedFile): PhotosMapResult {
  const avisos: ImportRowIssue[] = [];
  const byPeca = new Map<string, PhotoPlanItem>();
  const urlsDaPeca = new Map<string, Set<string>>();
  let invalidRows = 0;
  let urlsInvalidas = 0;
  let urlsDuplicadas = 0;
  let truncadas = 0;

  const read = aliasReader(file);

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const linha = i + 1;

    const sku = asString(read(row, "# idPeca", "idPeca"));
    if (!sku) {
      invalidRows++;
      addIssue(avisos, { linha, motivo: "Linha sem '# idPeca' — ignorada" });
      continue;
    }

    const url = asString(read(row, "Link das imagens", "Link da imagem"));
    if (!url || !isHttpUrl(url)) {
      urlsInvalidas++;
      addIssue(avisos, {
        linha,
        motivo: url
          ? `Peça ${sku}: link "${url.slice(0, 80)}" não é http(s) — ignorado`
          : `Peça ${sku}: linha sem link de imagem — ignorada`,
      });
      continue;
    }

    let item = byPeca.get(sku);
    if (!item) {
      item = { linha, sku, urls: [] };
      byPeca.set(sku, item);
      urlsDaPeca.set(sku, new Set());
    }
    const vistas = urlsDaPeca.get(sku)!;
    if (vistas.has(url)) {
      urlsDuplicadas++;
      continue;
    }
    vistas.add(url);
    if (item.urls.length >= MAX_FOTOS_POR_PECA) {
      truncadas++;
      continue;
    }
    item.urls.push(url);
  }

  // Peça que só tinha linhas inválidas não vira item (nunca grava array vazio).
  const items = Array.from(byPeca.values()).filter((i) => i.urls.length > 0);

  if (truncadas > 0) {
    addIssue(avisos, {
      motivo: `${truncadas} foto(s) acima do limite de ${MAX_FOTOS_POR_PECA} por peça foram descartadas.`,
    });
  }

  return {
    items,
    totalRows: file.rows.length,
    invalidRows,
    urlsInvalidas,
    urlsDuplicadas,
    avisos,
  };
}
