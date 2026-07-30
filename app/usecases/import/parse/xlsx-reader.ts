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
import { ImportValidationError } from "../import.types";
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
 * geraria centenas de milhões de células null e derrubaria o processo.
 *
 * ⚠️ ESTE ERA O SEGUNDO LIMITE. Era um teto FIXO de 5.000.000 de células, e
 * sozinho já recusava um export legítimo: o arquivo de fotos do Emp595
 * (36,1 MB) declara 653.240 linhas × 12 colunas = 7.838.880 células. Elevar só
 * o limite de upload não resolveria nada — o arquivo subiria e morreria aqui.
 *
 * O teto fixo é a ferramenta errada porque mistura duas coisas: uma BOMBA é um
 * arquivo PEQUENO declarando uma faixa ENORME; um export legítimo grande é um
 * arquivo GRANDE declarando uma faixa proporcionalmente grande. Quem separa os
 * dois é a RAZÃO células/byte comprimido, não o número absoluto:
 *
 *   medido, exports reais .... 0,18 (4,6 MB / 858k) e 0,22 (36,1 MB / 7,84M)
 *   bomba típica ............. ~70.000 (10 KB declarando A1:ZZ1048576)
 *
 * Então o orçamento é `bytes × CELLS_PER_BYTE`, preso entre um piso e um teto:
 *
 *  - PISO = 5.000.000, o valor antigo. É o que garante ZERO REGRESSÃO: toda
 *    planilha que passava antes continua passando, porque o orçamento nunca é
 *    menor do que era. Também é o que mantém a guarda APERTADA para arquivos
 *    pequenos — exatamente onde as bombas vivem.
 *  - TETO = orçamento de MEMÓRIA do processo, não de gosto. Medido com o
 *    arquivo real: 7,84M células = ~1,03 GB de heap no XLSX.read (modo denso),
 *    ou seja ~137 bytes por célula. 15M células projetam ~2,0 GB de pico — que
 *    cabe no heap padrão do Node (~4 GB) com folga, e no host da VPS (31 GiB,
 *    ~16 GiB livres) sem competir com o container do rembg. Ajustável por env
 *    para não exigir deploy se um cliente futuro precisar de mais.
 *
 * Com CELLS_PER_BYTE = 2 a folga é de ~9× sobre o pior export real e ainda
 * ~35.000× abaixo da razão de uma bomba.
 */
const SHEET_CELLS_FLOOR = 5_000_000;
const SHEET_CELLS_CEILING = Math.max(
  SHEET_CELLS_FLOOR,
  Number(process.env.IMPORT_MAX_SHEET_CELLS) || 15_000_000,
);
const CELLS_PER_BYTE = 2;

/** Orçamento de células permitido para um arquivo de `bytes` bytes. */
export function sheetCellBudget(bytes: number): number {
  const proportional = Math.max(0, bytes) * CELLS_PER_BYTE;
  return Math.min(
    SHEET_CELLS_CEILING,
    Math.max(SHEET_CELLS_FLOOR, proportional),
  );
}

/**
 * Aba a usar: a PRIMEIRA que tem dados (cabeçalho + ≥1 linha). Workbooks reais
 * chegam com uma aba de capa/instruções vazia na frente, e pegar `[0]` cego
 * fazia o arquivo inteiro cair em DESCONHECIDO. Se nenhuma aba tiver dados,
 * devolve a primeira — comportamento idêntico ao de antes.
 */
function pickSheetName(wb: ReturnType<typeof XLSX.read>): string {
  for (const name of wb.SheetNames) {
    const ref = wb.Sheets[name]?.["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    if (range.e.r - range.s.r >= 1) return name;
  }
  return wb.SheetNames[0];
}

export function readXlsxBuffer(buffer: Buffer): ParsedWorkbook {
  // `dense: true` guarda o sheet como matriz de linhas em vez do mapa esparso
  // {A1:{…}, B1:{…}} — mesma informação, muito menos objeto. Medido no arquivo
  // real de 36,1 MB: XLSX.read 25,0s → 16,2s, sheet_to_json 7,3s → 0,35s
  // (32,3s → 16,5s no total) e ~1,36 GB → ~1,03 GB de heap. NÃO muda a saída:
  // o sha256 do sheet_to_json completo das 653.239 linhas é IDÊNTICO nos dois
  // modos, e o `sheet_to_json` da própria lib trata os dois formatos.
  const wb = XLSX.read(buffer, { type: "buffer", dense: true });
  const sheetName = pickSheetName(wb);
  if (!sheetName) throw new Error("Planilha sem abas");
  const sheet = wb.Sheets[sheetName];
  const ref = sheet?.["!ref"];
  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    const cells =
      (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    const budget = sheetCellBudget(buffer.length);
    if (cells > budget) {
      // ImportValidationError (e não Error genérico): `sendImportError` só
      // converte estas duas classes em 4xx — com Error cru o operador recebia
      // um 500 "Erro na importação de dados" para um arquivo que ele PODE
      // consertar. Era o que aconteceria com a planilha do Emp595 se só o
      // limite de upload tivesse sido elevado.
      throw new ImportValidationError(
        `Planilha declara ${cells.toLocaleString("pt-BR")} células — acima do limite suportado (${budget.toLocaleString("pt-BR")} para um arquivo deste tamanho). Se a planilha é legítima, divida-a em partes; se não, confira se o arquivo não está corrompido.`,
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
