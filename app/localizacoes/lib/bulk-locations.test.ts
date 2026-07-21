import { describe, it, expect } from "vitest";
import {
  MAX_CAPACITY,
  MAX_CODE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_LOCATIONS_PER_ROW,
  MAX_PADDING,
  MAX_ROWS_PER_BATCH,
  MAX_TOTAL_LOCATIONS,
  dedupePlanItems,
  describeBatchError,
  describeRowError,
  expandBulkLocationRow,
  expandBulkLocationRows,
  formatLocationCode,
  normalizeCapacity,
  normalizeIntInput,
  normalizePadding,
  rangeSize,
  validateBulkLocationRows,
  type BulkLocationRow,
} from "./bulk-locations";

const row = (over: Partial<BulkLocationRow> = {}): BulkLocationRow => ({
  prefix: "PRT-",
  start: 1,
  end: 3,
  ...over,
});

describe("normalizeIntInput", () => {
  it("aceita inteiros e strings numéricas inteiras", () => {
    expect(normalizeIntInput(5)).toBe(5);
    expect(normalizeIntInput("7")).toBe(7);
    expect(normalizeIntInput(0)).toBe(0);
    expect(normalizeIntInput(-2)).toBe(-2);
  });

  it("rejeita vazio, não-numérico e decimal", () => {
    for (const v of [undefined, null, "", "   ", "abc", NaN, 1.5, "4.9"]) {
      expect(normalizeIntInput(v)).toBeNull();
    }
  });
});

describe("normalizePadding", () => {
  it("vazio ou inválido vira 0", () => {
    for (const v of [undefined, null, "", "   ", "abc", NaN, -1]) {
      expect(normalizePadding(v)).toBe(0);
    }
  });

  it("faz floor e respeita o teto", () => {
    expect(normalizePadding(2)).toBe(2);
    expect(normalizePadding("3")).toBe(3);
    expect(normalizePadding(2.9)).toBe(2);
    expect(normalizePadding(999)).toBe(MAX_PADDING);
  });
});

describe("normalizeCapacity", () => {
  it("vazio ou inválido vira 0 e decimal sofre floor", () => {
    expect(normalizeCapacity("")).toBe(0);
    expect(normalizeCapacity(undefined)).toBe(0);
    expect(normalizeCapacity("abc")).toBe(0);
    expect(normalizeCapacity(10.7)).toBe(10);
    expect(normalizeCapacity("12")).toBe(12);
  });

  it("preserva negativo para a validação reprovar", () => {
    expect(normalizeCapacity(-1)).toBe(-1);
  });
});

describe("formatLocationCode / expandBulkLocationRow", () => {
  it("expande sem padding", () => {
    expect(expandBulkLocationRow(row())).toEqual(["PRT-1", "PRT-2", "PRT-3"]);
  });

  it("expande com padding de 2 e de 3 dígitos", () => {
    const dois = expandBulkLocationRow(row({ end: 40, padding: 2 }));
    expect(dois).toHaveLength(40);
    expect(dois[0]).toBe("PRT-01");
    expect(dois[39]).toBe("PRT-40");
    expect(expandBulkLocationRow(row({ end: 1, padding: 3 }))).toEqual(["PRT-001"]);
  });

  it("padding NUNCA trunca número maior que os dígitos", () => {
    expect(formatLocationCode("PRT-", 100, 2)).toBe("PRT-100");
  });

  it("normaliza para maiúsculas e apara as pontas, preservando espaço interno", () => {
    expect(formatLocationCode(" prt-", 1, 0)).toBe("PRT-1");
    expect(formatLocationCode("prt- ", 1, 0)).toBe("PRT- 1");
  });

  it("start igual a end gera um único código", () => {
    expect(expandBulkLocationRow(row({ start: 7, end: 7 }))).toEqual(["PRT-7"]);
  });

  it("fim menor que início não gera nada", () => {
    expect(expandBulkLocationRow(row({ start: 5, end: 2 }))).toEqual([]);
  });
});

describe("validateBulkLocationRows — faixa inválida", () => {
  it("reprova fim menor que início", () => {
    const v = validateBulkLocationRows([row({ start: 5, end: 2 })]);
    expect(v.rows[0].rangeOk).toBe(false);
    expect(v.rows[0].count).toBe(0);
    expect(v.canGenerate).toBe(false);
  });

  it("reprova início/fim não inteiros", () => {
    const v = validateBulkLocationRows([row({ start: "", end: "abc" })]);
    expect(v.rows[0].startOk).toBe(false);
    expect(v.rows[0].endOk).toBe(false);
    expect(validateBulkLocationRows([row({ start: 1.5 })]).rows[0].startOk).toBe(false);
  });

  it("reprova prefixo vazio ou só espaços", () => {
    expect(validateBulkLocationRows([row({ prefix: "" })]).rows[0].prefixOk).toBe(false);
    expect(validateBulkLocationRows([row({ prefix: "   " })]).rows[0].prefixOk).toBe(false);
  });

  it("reprova capacidade negativa e descrição longa demais", () => {
    expect(validateBulkLocationRows([row({ maxCapacity: -1 })]).rows[0].capacityOk).toBe(false);
    const longa = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
    expect(validateBulkLocationRows([row({ description: longa })]).rows[0].descriptionOk).toBe(false);
  });

  it("reprova sigla gerada acima do limite de caracteres", () => {
    const prefixo = "A".repeat(MAX_CODE_LENGTH - 1);
    const v = validateBulkLocationRows([{ prefix: prefixo, start: 1, end: 99 }]);
    expect(v.rows[0].codeLengthOk).toBe(false);
    expect(v.canGenerate).toBe(false);
  });
});

describe("validateBulkLocationRows — tetos", () => {
  it("aceita exatamente o teto por faixa e reprova um a mais", () => {
    const noLimite = validateBulkLocationRows([row({ start: 1, end: MAX_LOCATIONS_PER_ROW })]);
    expect(noLimite.rows[0].countOk).toBe(true);
    expect(noLimite.rows[0].count).toBe(MAX_LOCATIONS_PER_ROW);

    const acima = validateBulkLocationRows([row({ start: 1, end: MAX_LOCATIONS_PER_ROW + 1 })]);
    expect(acima.rows[0].countOk).toBe(false);
    expect(acima.canGenerate).toBe(false);
  });

  it("estoura o teto do lote sem invalidar as faixas individualmente", () => {
    const rows = [
      { prefix: "A-", start: 1, end: MAX_LOCATIONS_PER_ROW },
      { prefix: "B-", start: 1, end: MAX_LOCATIONS_PER_ROW },
      { prefix: "C-", start: 1, end: MAX_LOCATIONS_PER_ROW },
    ];
    const v = validateBulkLocationRows(rows);
    expect(v.totalLocations).toBe(MAX_LOCATIONS_PER_ROW * 3);
    expect(v.totalLocations).toBeGreaterThan(MAX_TOTAL_LOCATIONS);
    expect(v.allRowsValid).toBe(true);
    expect(v.overCap).toBe(true);
    expect(v.canGenerate).toBe(false);
  });

  it("reprova quando há faixas demais", () => {
    const rows = Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, (_, i) => ({
      prefix: `P${i}-`,
      start: 1,
      end: 1,
    }));
    const v = validateBulkLocationRows(rows);
    expect(v.tooManyRows).toBe(true);
    expect(v.canGenerate).toBe(false);
  });

  it("lista vazia não gera nada", () => {
    const v = validateBulkLocationRows([]);
    expect(v.hasValidRows).toBe(false);
    expect(v.allRowsValid).toBe(false);
    expect(v.totalLocations).toBe(0);
    expect(v.canGenerate).toBe(false);
  });
});

describe("validateBulkLocationRows — duplicatas dentro do lote", () => {
  it("marca AMBAS as faixas que geram a mesma sigla", () => {
    const v = validateBulkLocationRows([
      { prefix: "PRT-", start: 1, end: 5 },
      { prefix: "PRT-", start: 3, end: 8 },
    ]);
    expect(v.rows[0].duplicateInBatch).toBe(true);
    expect(v.rows[1].duplicateInBatch).toBe(true);
    expect(v.duplicateCodes.sort()).toEqual(["PRT-3", "PRT-4", "PRT-5"]);
    expect(v.canGenerate).toBe(false);
  });

  it("padding diferente NÃO colide (PRT-1 e PRT-01 são siglas distintas)", () => {
    const v = validateBulkLocationRows([
      { prefix: "PRT-", start: 1, end: 9 },
      { prefix: "PRT-", start: 1, end: 9, padding: 2 },
    ]);
    expect(v.duplicateCodes).toEqual([]);
    expect(v.canGenerate).toBe(true);
    expect(v.totalLocations).toBe(18);
  });

  it("faixas com prefixos diferentes convivem", () => {
    const v = validateBulkLocationRows([
      { prefix: "PRT-", start: 1, end: 40, padding: 2 },
      { prefix: "CX-", start: 1, end: 20 },
    ]);
    expect(v.canGenerate).toBe(true);
    expect(v.totalLocations).toBe(60);
  });
});

describe("proteção contra expansão descontrolada", () => {
  it("faixa absurda é reprovada SEM materializar os códigos", () => {
    const inicio = Date.now();
    const v = validateBulkLocationRows([
      { prefix: "A-", start: 1, end: 2_000_000_000 },
    ]);
    // Se expandisse, o processo travaria; tem que reprovar de imediato.
    expect(Date.now() - inicio).toBeLessThan(1000);
    expect(v.rows[0].countOk).toBe(false);
    expect(v.rows[0].sampleFirst).toEqual([]);
    expect(v.canGenerate).toBe(false);
    expect(expandBulkLocationRow({ prefix: "A-", start: 1, end: 2_000_000_000 })).toEqual([]);
  });

  it("rangeSize calcula o tamanho sem expandir", () => {
    expect(rangeSize({ prefix: "A-", start: 1, end: 40 })).toBe(40);
    expect(rangeSize({ prefix: "A-", start: 7, end: 7 })).toBe(1);
    expect(rangeSize({ prefix: "A-", start: 5, end: 2 })).toBeNull();
    expect(rangeSize({ prefix: "A-", start: "", end: 2 })).toBeNull();
    expect(rangeSize({ prefix: "A-", start: 1, end: 1_000_000_000 })).toBe(1_000_000_000);
  });

  it("faixas demais não expandem nada", () => {
    const rows = Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, (_, i) => ({
      prefix: `P${i}-`,
      start: 1,
      end: MAX_LOCATIONS_PER_ROW,
    }));
    const v = validateBulkLocationRows(rows);
    expect(v.tooManyRows).toBe(true);
    expect(v.canGenerate).toBe(false);
    expect(v.rows.every((r) => r.sampleFirst.length === 0)).toBe(true);
    // A UI indexa validation.rows[i]: precisa haver uma entrada por faixa.
    expect(v.rows).toHaveLength(rows.length);
  });

  it("capacidade acima do teto é reprovada (estouraria o Int do banco)", () => {
    expect(
      validateBulkLocationRows([{ prefix: "A-", start: 1, end: 1, maxCapacity: MAX_CAPACITY + 1 }])
        .rows[0].capacityOk,
    ).toBe(false);
    expect(
      validateBulkLocationRows([{ prefix: "A-", start: 1, end: 1, maxCapacity: MAX_CAPACITY }])
        .rows[0].capacityOk,
    ).toBe(true);
  });
});

describe("expandBulkLocationRows", () => {
  it("converte parentId vazio em raiz (FK vazia derrubaria o lote)", () => {
    const items = expandBulkLocationRows([
      { prefix: "A-", start: 1, end: 1, parentId: "" },
    ]);
    expect(items[0].parentId).toBeNull();
  });

  it("preserva a ordem e leva mãe, capacidade e descrição de cada faixa", () => {
    const items = expandBulkLocationRows([
      { prefix: "PRT-", start: 1, end: 2, maxCapacity: 10, description: " Prateleira ", parentId: "loc-galpao" },
      { prefix: "CX-", start: 1, end: 1 },
    ]);
    expect(items.map((i) => i.code)).toEqual(["PRT-1", "PRT-2", "CX-1"]);
    expect(items[0]).toMatchObject({
      parentId: "loc-galpao",
      maxCapacity: 10,
      description: "Prateleira",
      rowIndex: 0,
    });
    expect(items[2]).toMatchObject({
      parentId: null,
      maxCapacity: 0,
      description: null,
      rowIndex: 1,
    });
  });

  it("não deduplica — isso é responsabilidade de dedupePlanItems", () => {
    const items = expandBulkLocationRows([
      { prefix: "PRT-", start: 1, end: 2 },
      { prefix: "PRT-", start: 2, end: 3 },
    ]);
    expect(items.map((i) => i.code)).toEqual(["PRT-1", "PRT-2", "PRT-2", "PRT-3"]);
  });
});

describe("dedupePlanItems", () => {
  it("mantém a primeira ocorrência e reporta as repetidas", () => {
    const items = expandBulkLocationRows([
      { prefix: "PRT-", start: 1, end: 2, parentId: "pai-a" },
      { prefix: "PRT-", start: 2, end: 3, parentId: "pai-b" },
    ]);
    const { items: kept, duplicates } = dedupePlanItems(items);
    expect(kept.map((i) => i.code)).toEqual(["PRT-1", "PRT-2", "PRT-3"]);
    expect(duplicates).toEqual(["PRT-2"]);
    // keep-first: o PRT-2 mantido é o da PRIMEIRA faixa.
    expect(kept.find((i) => i.code === "PRT-2")?.parentId).toBe("pai-a");
  });

  it("lista sem repetição passa intacta", () => {
    const items = expandBulkLocationRows([{ prefix: "PRT-", start: 1, end: 3 }]);
    const { items: kept, duplicates } = dedupePlanItems(items);
    expect(kept).toHaveLength(3);
    expect(duplicates).toEqual([]);
  });
});

describe("describeRowError / describeBatchError", () => {
  it("faixa válida não tem erro", () => {
    const v = validateBulkLocationRows([row()]);
    expect(describeRowError(v.rows[0])).toBeNull();
    expect(describeBatchError(v)).toBeNull();
  });

  it("aponta o problema específico de cada faixa", () => {
    expect(describeRowError(validateBulkLocationRows([row({ prefix: "" })]).rows[0])).toContain("prefixo");
    expect(describeRowError(validateBulkLocationRows([row({ start: 5, end: 2 })]).rows[0])).toContain("fim");
    expect(
      describeRowError(validateBulkLocationRows([row({ end: MAX_LOCATIONS_PER_ROW + 2 })]).rows[0]),
    ).toContain(String(MAX_LOCATIONS_PER_ROW));
    expect(describeRowError(validateBulkLocationRows([row({ maxCapacity: -1 })]).rows[0])).toContain("Capacidade");
  });

  it("o teto do lote tem prioridade sobre erro de faixa", () => {
    const rows = [
      { prefix: "A-", start: 1, end: MAX_LOCATIONS_PER_ROW },
      { prefix: "B-", start: 1, end: MAX_LOCATIONS_PER_ROW },
      { prefix: "C-", start: 1, end: MAX_LOCATIONS_PER_ROW },
    ];
    const msg = describeBatchError(validateBulkLocationRows(rows));
    expect(msg).toContain(String(MAX_TOTAL_LOCATIONS));
  });

  it("identifica a faixa problemática pelo número", () => {
    const msg = describeBatchError(
      validateBulkLocationRows([row(), { prefix: "CX-", start: 9, end: 1 }]),
    );
    expect(msg).toContain("Faixa 2");
  });
});
