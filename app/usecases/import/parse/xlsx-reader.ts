/**
 * Leitura de XLSX/XLS a partir de Buffer (lib `xlsx`/SheetJS, já dependência
 * do projeto). Dois formatos reais:
 *
 * 1. Header normal na 1ª linha (Clientes/Backup Pecas/Backup Veiculos):
 *    `sheet_to_json` direto; acesso via getter normKey (acento/caixa-safe).
 * 2. Rótulos DESLOCADOS (resumo de NF-e "invoicy", aba "Java Books"): o
 *    header do sheet é a linha de TÍTULO; a 1ª linha de DADOS traz os
 *    rótulos reais. Mesma técnica de scripts/migracao-vaapt-nfes.ts:
 *    labels = rows[0], dados = rows.slice(1).
 */

import XLSX from "xlsx";
import type { ImportRow } from "../import.types";
import { asString, normKey } from "../lib/normalize";
import type { ParsedTable } from "./csv-reader";

export interface ParsedWorkbook extends ParsedTable {
  sheetName: string;
  /** true quando a linha de rótulos estava deslocada (formato invoicy). */
  shiftedLabels: boolean;
}

/**
 * Guarda anti-bomba de dimensão: sheet_to_json materializa TODA a faixa
 * declarada em `!ref` — um xlsx pequeno com dimensão forjada (A1:ZZ1048576)
 * geraria centenas de milhões de células null e derrubaria o processo. O
 * maior arquivo real (peças Vaapt) tem ~36,6k linhas × 18 colunas ≈ 660k.
 */
const MAX_SHEET_CELLS = 5_000_000;

export function readXlsxBuffer(buffer: Buffer): ParsedWorkbook {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Planilha sem abas");
  const sheet = wb.Sheets[sheetName];
  const ref = sheet?.["!ref"];
  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    const cells =
      (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    if (cells > MAX_SHEET_CELLS) {
      throw new Error(
        `Planilha declara ${cells.toLocaleString("pt-BR")} células — acima do limite suportado. Confira se o arquivo não está corrompido.`,
      );
    }
  }
  const raw = XLSX.utils.sheet_to_json<ImportRow>(sheet, { defval: null });

  // Header "de verdade" = chaves do sheet_to_json. Formato deslocado
  // (invoicy): o header é a linha de TÍTULO — exatamente 1 célula nomeada e
  // o resto __EMPTY_* — e os rótulos reais estão na 1ª linha de dados.
  // Heurística estrita para não engolir planilha normal com colunas sem
  // nome: precisa de ≥4 colunas, quase tudo __EMPTY, E a linha candidata a
  // rótulos precisa render ≥3 rótulos de verdade.
  const headerKeys = raw.length > 0 ? Object.keys(raw[0]) : [];
  const emptyish = headerKeys.filter((k) => k.startsWith("__EMPTY")).length;
  const shiftedCandidate =
    headerKeys.length >= 4 && emptyish >= headerKeys.length - 1;

  if (shiftedCandidate) {
    const labelRow = raw[0] ?? {};
    const labelToKey = new Map<string, string>();
    const header: string[] = [];
    for (const key of Object.keys(labelRow)) {
      const lbl = asString(labelRow[key]);
      if (lbl) {
        labelToKey.set(normKey(lbl), key);
        header.push(lbl);
      }
    }
    if (header.length >= 3) {
      const rows = raw.slice(1);
      const get = (row: ImportRow, label: string): unknown => {
        const k = labelToKey.get(normKey(label));
        return k !== undefined ? (row[k] ?? null) : null;
      };
      return { sheetName, header, rows, get, shiftedLabels: true };
    }
  }

  const keyByNorm = new Map<string, string>();
  for (const k of headerKeys) keyByNorm.set(normKey(k), k);
  const get = (row: ImportRow, label: string): unknown => {
    const k = keyByNorm.get(normKey(label));
    return k !== undefined ? (row[k] ?? null) : null;
  };
  return { sheetName, header: headerKeys, rows: raw, get, shiftedLabels: false };
}

/** Sniff do formato pelo magic number (nunca pela extensão do nome). */
export function sniffFileFormat(buffer: Buffer): "xlsx" | "xls" | "csv" | "xml" {
  if (buffer.length >= 4) {
    // ZIP (xlsx) = "PK\x03\x04"
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "xlsx";
    // OLE2 (xls) = D0 CF 11 E0
    if (
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0
    ) {
      return "xls";
    }
  }
  const head = buffer.subarray(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<")) return "xml";
  return "csv";
}
