/**
 * Parser CSV próprio (cópia fiel de scripts/migracao-webdesmonte.ts) —
 * mantém TUDO como string para preservar zeros à esquerda de SKU/CPF/CEP,
 * trata aspas, "" escapado, vírgulas e quebras de linha dentro de aspas, e
 * remove BOM do header. Nada de coerção numérica na leitura.
 */

import type { ImportRow } from "../import.types";
import { normKey } from "../lib/normalize";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export interface ParsedTable {
  header: string[];
  rows: ImportRow[];
  /** Getter por rótulo normalizado (acento/caixa-insensível). */
  get: (row: ImportRow, label: string) => unknown;
}

/** CSV (Buffer utf-8) → linhas keyed pelo header original + getter normKey. */
export function readCsvBuffer(buffer: Buffer): ParsedTable {
  const text = buffer.toString("utf8");
  const matrix = parseCsv(text);
  if (matrix.length === 0) return { header: [], rows: [], get: () => null };
  const header = matrix[0].map((h) => h.replace(/^﻿/, "").trim());
  const keyByNorm = new Map<string, string>();
  for (const h of header) keyByNorm.set(normKey(h), h);

  const rows: ImportRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    if (cells.length === 1 && cells[0] === "") continue; // linha vazia
    const obj: ImportRow = {};
    for (let c = 0; c < header.length; c++) {
      const v = cells[c];
      obj[header[c]] = v === undefined || v === "" ? null : v;
    }
    rows.push(obj);
  }

  const get = (row: ImportRow, label: string): unknown => {
    const k = keyByNorm.get(normKey(label));
    return k !== undefined ? (row[k] ?? null) : null;
  };
  return { header, rows, get };
}
