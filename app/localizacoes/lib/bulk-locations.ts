// Núcleo PURO (sem React/DOM/fetch) da criação de localizações EM MASSA.
// Espelha o shape de `app/produtos/lib/standalone-labels.ts` (validação que
// devolve estrutura em vez de lançar + expansão + caps exportados), mas aqui
// o resultado é PERSISTIDO — por isso o dialog e a rota Fastify importam ESTE
// mesmo módulo: o preview do usuário e o que o servidor grava saem da mesma
// função, sem chance de divergir.

/** Máximo de localizações que UMA faixa pode gerar. */
export const MAX_LOCATIONS_PER_ROW = 200;
/** Máximo de localizações somando todas as faixas do lote. */
export const MAX_TOTAL_LOCATIONS = 500;
/** Máximo de faixas por lote (mantém o payload e o log do sistema enxutos). */
export const MAX_ROWS_PER_BATCH = 20;
/** Espelha a regra de `location.routes.ts` para a sigla. */
export const MAX_CODE_LENGTH = 20;
/** Espelha a regra de `location.routes.ts` para a descrição. */
export const MAX_DESCRIPTION_LENGTH = 200;
/** Teto de zeros à esquerda (PRT-0000000001 já é absurdo). */
export const MAX_PADDING = 10;
/** Teto da capacidade: acima disso o Postgres estoura o Int4 da coluna. */
export const MAX_CAPACITY = 1_000_000;

/** Uma faixa: "PRT-" de 1 a 40 com 2 dígitos → PRT-01 … PRT-40. */
export interface BulkLocationRow {
  prefix: string;
  start?: number | string;
  end?: number | string;
  /** Zeros à esquerda. Vazio/0 = sem padding. */
  padding?: number | string;
  maxCapacity?: number | string;
  description?: string;
  /** null/ausente = criar na raiz. */
  parentId?: string | null;
}

/** Uma localização a criar, já normalizada. */
export interface BulkLocationPlanItem {
  code: string;
  parentId: string | null;
  maxCapacity: number;
  description: string | null;
  rowIndex: number;
}

export interface BulkLocationRowValidation {
  index: number;
  prefixOk: boolean;
  startOk: boolean;
  endOk: boolean;
  rangeOk: boolean;
  countOk: boolean;
  paddingOk: boolean;
  capacityOk: boolean;
  descriptionOk: boolean;
  codeLengthOk: boolean;
  duplicateInBatch: boolean;
  /** Quantas localizações a faixa gera (0 quando inválida). */
  count: number;
  /** Até 3 primeiros códigos, para o preview. */
  sampleFirst: string[];
  /** Último código, para o preview ("… PRT-40"). */
  sampleLast: string | null;
  valid: boolean;
}

export interface BulkLocationListValidation {
  rows: BulkLocationRowValidation[];
  hasValidRows: boolean;
  allRowsValid: boolean;
  tooManyRows: boolean;
  totalLocations: number;
  overCap: boolean;
  /** Códigos repetidos ENTRE faixas do mesmo lote. */
  duplicateCodes: string[];
  canGenerate: boolean;
}

/** Inteiro finito ou null. Aceita string numérica; rejeita vazio/NaN/decimal. */
export function normalizeIntInput(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

/** Vazio/inválido → 0; decimal → floor; clamp em [0, MAX_PADDING]. */
export function normalizePadding(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string" && value.trim() === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  if (floored < 0) return 0;
  if (floored > MAX_PADDING) return MAX_PADDING;
  return floored;
}

/** Vazio/inválido → 0; decimal → floor; negativo continua negativo (a
 *  validação reprova) para não mascarar erro de digitação do usuário. */
export function normalizeCapacity(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string" && value.trim() === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

/**
 * Monta o código final. `padStart` NUNCA trunca: com padding 2, n=100 continua
 * "100". O trim/uppercase é aplicado no código JÁ montado (não no prefixo), o
 * que preserva espaço interno: "prt- " + 1 → "PRT- 1".
 */
export function formatLocationCode(
  prefix: string,
  n: number,
  padding: number,
): string {
  const digits = String(n).padStart(padding, "0");
  return `${prefix ?? ""}${digits}`.trim().toUpperCase();
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Quantas localizações a faixa geraria, SEM materializar nada. Existe para que
 * o teto seja aplicado antes da expansão: `{start:1, end:2000000000}` cabe em
 * 50 bytes de JSON e derrubaria o processo se fosse expandido antes de checar.
 * Devolve null quando a faixa é inconsistente.
 */
export function rangeSize(row: BulkLocationRow): number | null {
  const start = normalizeIntInput(row?.start);
  const end = normalizeIntInput(row?.end);
  if (start === null || end === null || end < start) return null;
  return end - start + 1;
}

/**
 * Códigos de UMA faixa. Faixa maior que o teto devolve [] SEM expandir — a
 * validação já a reprova por `countOk`, então materializar seria trabalho
 * jogado fora (e, com um `end` absurdo, um travamento).
 */
export function expandBulkLocationRow(row: BulkLocationRow): string[] {
  const size = rangeSize(row);
  if (size === null || size > MAX_LOCATIONS_PER_ROW) return [];
  const start = normalizeIntInput(row?.start) as number;
  const padding = normalizePadding(row?.padding);
  const codes: string[] = [];
  for (let i = 0; i < size; i++) {
    codes.push(formatLocationCode(row?.prefix ?? "", start + i, padding));
  }
  return codes;
}

/** Expande todas as faixas na ordem. NÃO deduplica (ver `dedupePlanItems`). */
export function expandBulkLocationRows(
  rows: BulkLocationRow[],
): BulkLocationPlanItem[] {
  const items: BulkLocationPlanItem[] = [];
  rows.forEach((row, rowIndex) => {
    const description = typeof row?.description === "string" ? row.description.trim() : "";
    for (const code of expandBulkLocationRow(row)) {
      items.push({
        code,
        // `|| null` (não `??`): string vazia precisa virar raiz, senão iria
        // como FK vazia para o banco — mesma normalização do POST /locations.
        parentId: row?.parentId || null,
        maxCapacity: normalizeCapacity(row?.maxCapacity),
        description: description || null,
        rowIndex,
      });
    }
  });
  return items;
}

/** Remove códigos repetidos mantendo a PRIMEIRA ocorrência. */
export function dedupePlanItems(items: BulkLocationPlanItem[]): {
  items: BulkLocationPlanItem[];
  duplicates: string[];
} {
  const seen = new Set<string>();
  const kept: BulkLocationPlanItem[] = [];
  const duplicates: string[] = [];
  for (const item of items) {
    if (seen.has(item.code)) {
      duplicates.push(item.code);
      continue;
    }
    seen.add(item.code);
    kept.push(item);
  }
  return { items: kept, duplicates };
}

/**
 * Valida o lote inteiro. NUNCA lança — devolve flags, e quem bloqueia é a UI
 * (ou a rota). Diferente de `normalizeQuantity` do standalone, o teto por
 * faixa REPROVA em vez de clampar: reduzir "PRT-1..300" para "PRT-1..200" em
 * silêncio criaria menos localizações do que o usuário pediu.
 */
export function validateBulkLocationRows(
  rows: BulkLocationRow[],
): BulkLocationListValidation {
  const list = Array.isArray(rows) ? rows : [];
  const tooManyRows = list.length > MAX_ROWS_PER_BATCH;

  // Conta ocorrências de cada código no lote inteiro (para duplicata entre
  // faixas). Com faixas demais o lote já está reprovado — não expandimos nada,
  // para o trabalho nunca ser proporcional a um input não confiável.
  const codeCount = new Map<string, number>();
  const rowCodes: string[][] = list.map((row) => {
    const codes = tooManyRows ? [] : expandBulkLocationRow(row);
    for (const code of codes) {
      codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
    }
    return codes;
  });

  const duplicateCodes: string[] = [];
  for (const [code, count] of codeCount) {
    if (count > 1) duplicateCodes.push(code);
  }

  const validated: BulkLocationRowValidation[] = list.map((row, index) => {
    const codes = rowCodes[index] ?? [];
    const start = normalizeIntInput(row?.start);
    const end = normalizeIntInput(row?.end);
    const rawPadding = row?.padding;
    const paddingNum =
      rawPadding === null || rawPadding === undefined || String(rawPadding).trim() === ""
        ? 0
        : Number(rawPadding);

    const size = rangeSize(row);
    const prefixOk = isNonEmpty(row?.prefix);
    const startOk = start !== null;
    const endOk = end !== null;
    const rangeOk = startOk && endOk && (end as number) >= (start as number);
    // Pelo tamanho da faixa, não pelos códigos: faixa acima do teto nem chega
    // a ser expandida.
    const countOk = size !== null && size > 0 && size <= MAX_LOCATIONS_PER_ROW;
    const paddingOk =
      !Number.isFinite(paddingNum) ||
      (Number.isInteger(paddingNum) && paddingNum >= 0 && paddingNum <= MAX_PADDING);
    const capacity = normalizeCapacity(row?.maxCapacity);
    const capacityOk = capacity >= 0 && capacity <= MAX_CAPACITY;
    const descriptionOk =
      typeof row?.description !== "string" ||
      row.description.trim().length <= MAX_DESCRIPTION_LENGTH;
    // Basta checar o mais longo: o padding fixa o mínimo e o maior número o máximo.
    const longest = codes.reduce((max, c) => Math.max(max, c.length), 0);
    const codeLengthOk = longest <= MAX_CODE_LENGTH;
    const duplicateInBatch = codes.some((c) => (codeCount.get(c) ?? 0) > 1);

    const valid =
      prefixOk &&
      startOk &&
      endOk &&
      rangeOk &&
      countOk &&
      paddingOk &&
      capacityOk &&
      descriptionOk &&
      codeLengthOk &&
      !duplicateInBatch;

    return {
      index,
      prefixOk,
      startOk,
      endOk,
      rangeOk,
      countOk,
      paddingOk,
      capacityOk,
      descriptionOk,
      codeLengthOk,
      duplicateInBatch,
      count: valid ? codes.length : 0,
      sampleFirst: codes.slice(0, 3),
      sampleLast: codes.length > 0 ? codes[codes.length - 1] : null,
      valid,
    };
  });

  const hasValidRows = validated.some((r) => r.valid);
  const allRowsValid = validated.length > 0 && validated.every((r) => r.valid);
  const totalLocations = validated.reduce((sum, r) => sum + r.count, 0);
  const overCap = totalLocations > MAX_TOTAL_LOCATIONS;

  return {
    rows: validated,
    hasValidRows,
    allRowsValid,
    tooManyRows,
    totalLocations,
    overCap,
    duplicateCodes,
    canGenerate: allRowsValid && hasValidRows && !overCap && !tooManyRows,
  };
}

/** Mensagem PT-BR do primeiro problema da faixa, ou null se estiver ok. */
export function describeRowError(
  row: BulkLocationRowValidation,
): string | null {
  if (row.valid) return null;
  if (!row.prefixOk) return "Informe o prefixo (ex.: PRT-).";
  if (!row.startOk || !row.endOk) return "Início e fim devem ser números inteiros.";
  if (!row.rangeOk) return "O fim deve ser maior ou igual ao início.";
  if (!row.paddingOk) return `Dígitos deve ser um número entre 0 e ${MAX_PADDING}.`;
  if (!row.capacityOk)
    return `Capacidade máxima deve ser um número entre 0 e ${MAX_CAPACITY}.`;
  if (!row.descriptionOk)
    return `Descrição deve ter no máximo ${MAX_DESCRIPTION_LENGTH} caracteres.`;
  if (!row.codeLengthOk)
    return `A sigla gerada passa de ${MAX_CODE_LENGTH} caracteres.`;
  if (!row.countOk)
    return `Máximo de ${MAX_LOCATIONS_PER_ROW} localizações por faixa.`;
  if (row.duplicateInBatch) return "Esta faixa gera siglas repetidas no lote.";
  return "Faixa inválida.";
}

/** Mensagem PT-BR do lote (usada no 400 da rota e no rodapé do dialog). */
export function describeBatchError(
  validation: BulkLocationListValidation,
): string | null {
  if (validation.canGenerate) return null;
  if (validation.tooManyRows)
    return `Máximo de ${MAX_ROWS_PER_BATCH} faixas por lote.`;
  if (validation.overCap)
    return `Máximo de ${MAX_TOTAL_LOCATIONS} localizações por lote (${validation.totalLocations} no momento).`;
  if (!validation.hasValidRows && validation.rows.length === 0)
    return "Lista de faixas é obrigatória";
  const firstBad = validation.rows.find((r) => !r.valid);
  if (firstBad) {
    const detail = describeRowError(firstBad);
    return `Faixa ${firstBad.index + 1}: ${detail ? detail.charAt(0).toLowerCase() + detail.slice(1) : "inválida."}`;
  }
  return "Nenhuma faixa válida para criar.";
}
