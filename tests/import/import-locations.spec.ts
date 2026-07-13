import { describe, it, expect, vi, beforeEach } from "vitest";
import XLSX from "xlsx";

// O executor importa app/lib/prisma (via deps default) — mocka antes.
vi.mock("../../app/lib/prisma", () => ({
  default: {
    location: { findMany: vi.fn(async () => []) },
  },
}));

import {
  executeLocationPlan,
  runVaaptLocations,
  type LocationExecDeps,
  type LocationPlanItem,
} from "../../app/usecases/import/executors/locations.executor";
import { mapVaaptLocations } from "../../app/usecases/import/mappers/vaapt-localizacoes.mapper";
import { detectFile } from "../../app/usecases/import/import-detector";
import { newReport } from "../../app/usecases/import/import.types";
import type { ImportContext } from "../../app/usecases/import/import.types";

function pecasFile(rows: Array<[string, string | null]>) {
  const aoa: unknown[][] = [["# Cod Peca", "Localizacao"]];
  for (const [sku, loc] of rows) aoa.push([sku, loc]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Planilha1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return detectFile({ fieldname: "file", filename: "pecas.xlsx", buffer });
}

function makeDeps(existing: Array<{ id: string; code: string }> = []) {
  const created: Array<{ code: string; parentId?: string }> = [];
  let seq = 0;
  const deps: LocationExecDeps = {
    locationUseCase: {
      createLean: vi.fn(async (data: { code: string; parentId?: string }) => {
        created.push({ code: data.code, parentId: data.parentId });
        return { id: `loc-${++seq}`, code: data.code } as never;
      }),
    },
    loadExistingCodes: vi.fn(async () => existing),
  };
  return { deps, created };
}

const ctxBase = (dryRun: boolean): ImportContext => ({
  targetUserId: "admin-1",
  files: [],
  dryRun,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("import/locations — mapper Vaapt (plano)", () => {
  it("coleta textos distintos e normaliza flat (upper, sem espaços)", () => {
    const file = pecasFile([
      ["1", "Local 44 - Caixa 9"],
      ["2", "LOCAL 44 - CAIXA 9"], // mesma localização, caixa diferente
      ["3", "LOCAL 1"],
      ["4", null], // peça sem localização — não é erro
    ]);
    const r = mapVaaptLocations(file);
    expect(r.items.map((i) => i.code).sort()).toEqual([
      "LOCAL1",
      "LOCAL44-CAIXA9",
    ]);
    expect(r.rowsWithoutLocation).toBe(1);
    // Descrição preserva o texto original da 1ª ocorrência.
    const l44 = r.items.find((i) => i.code === "LOCAL44-CAIXA9");
    expect(l44?.description).toBe("Local 44 - Caixa 9");
    expect(l44?.maxCapacity).toBe(0);
  });
});

describe("import/locations — executor", () => {
  it("PRÉVIA (dryRun) não escreve NADA e conta a_criar/ja_existiam", async () => {
    const { deps } = makeDeps([{ id: "x", code: "LOCAL1" }]);
    const report = newReport("VAAPT", "LOCALIZACOES", "admin-1", true);
    const items: LocationPlanItem[] = [
      { code: "LOCAL1" },
      { code: "LOCAL2", description: "Local 2" },
    ];
    await executeLocationPlan(ctxBase(true), report, items, deps);
    expect(deps.locationUseCase.createLean).not.toHaveBeenCalled();
    expect(report.contadores.ja_existiam).toBe(1);
    expect(report.contadores.a_criar).toBe(1);
  });

  it("APPLY cria só as faltantes (idempotente: 2ª rodada = 0 criações)", async () => {
    const { deps, created } = makeDeps([{ id: "x", code: "LOCAL1" }]);
    const report = newReport("VAAPT", "LOCALIZACOES", "admin-1", false);
    const items: LocationPlanItem[] = [{ code: "LOCAL1" }, { code: "LOCAL2" }];
    await executeLocationPlan(ctxBase(false), report, items, deps);
    expect(created.map((c) => c.code)).toEqual(["LOCAL2"]);
    expect(report.contadores.criadas).toBe(1);
    expect(report.contadores.ja_existiam).toBe(1);

    // 2ª rodada: agora LOCAL2 também existe → nada é criado.
    const { deps: deps2, created: created2 } = makeDeps([
      { id: "x", code: "LOCAL1" },
      { id: "y", code: "LOCAL2" },
    ]);
    const report2 = newReport("VAAPT", "LOCALIZACOES", "admin-1", false);
    await executeLocationPlan(ctxBase(false), report2, items, deps2);
    expect(created2).toEqual([]);
    expect(report2.contadores.ja_existiam).toBe(2);
    expect(report2.contadores.criadas ?? 0).toBe(0);
  });

  it("hierarquia: pai criado antes vira parentId do filho", async () => {
    const { deps, created } = makeDeps();
    const report = newReport("WEBDESMONTE", "LOCALIZACOES", "admin-1", false);
    const items: LocationPlanItem[] = [
      { code: "GALPÃO" },
      { code: "GALPÃO > CAIXA 22", parentCode: "GALPÃO" },
    ];
    await executeLocationPlan(ctxBase(false), report, items, deps);
    expect(created[0]).toEqual({ code: "GALPÃO", parentId: undefined });
    expect(created[1].code).toBe("GALPÃO > CAIXA 22");
    expect(created[1].parentId).toBe("loc-1"); // id do pai recém-criado
  });

  it("pai não resolvido → erro de linha, sem derrubar o job", async () => {
    const { deps, created } = makeDeps();
    const report = newReport("WEBDESMONTE", "LOCALIZACOES", "admin-1", false);
    const items: LocationPlanItem[] = [
      { code: "FILHO", parentCode: "PAI-INEXISTENTE", linha: 7 },
      { code: "OK" },
    ];
    await executeLocationPlan(ctxBase(false), report, items, deps);
    expect(report.contadores.erros).toBe(1);
    expect(report.erros[0].motivo).toContain("PAI-INEXISTENTE");
    expect(created.map((c) => c.code)).toEqual(["OK"]);
  });

  it("corrida benigna ('já existe' no create) vira skip, não erro", async () => {
    const deps: LocationExecDeps = {
      locationUseCase: {
        createLean: vi.fn(async () => {
          throw new Error("Já existe uma localização com essa sigla");
        }),
      },
      loadExistingCodes: vi.fn(async () => []),
      findIdByCode: vi.fn(async () => ({ id: "loc-existente" })),
    };
    const report = newReport("VAAPT", "LOCALIZACOES", "admin-1", false);
    await executeLocationPlan(ctxBase(false), report, [{ code: "A" }], deps);
    expect(report.contadores.ja_existiam).toBe(1);
    expect(report.contadores.erros ?? 0).toBe(0);
  });

  it("runner VAAPT/LOCALIZACOES integra mapper + executor", async () => {
    const { deps } = makeDeps();
    const file = pecasFile([
      ["1", "Local 44 - Caixa 9"],
      ["2", "LOCAL 1"],
    ]);
    const report = await runVaaptLocations(
      { targetUserId: "admin-1", files: [file], dryRun: true },
      deps,
    );
    expect(report.contadores.localizacoes_distintas).toBe(2);
    expect(report.contadores.a_criar).toBe(2);
    expect(deps.locationUseCase.createLean).not.toHaveBeenCalled();
  });
});
