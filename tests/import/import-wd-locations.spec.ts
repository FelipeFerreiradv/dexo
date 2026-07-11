import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: { location: { findMany: vi.fn(async () => []) } },
}));

import { mapWdLocations } from "../../app/usecases/import/mappers/wd-localizacoes.mapper";
import {
  executeLocationPlan,
  runWdLocations,
  type LocationExecDeps,
} from "../../app/usecases/import/executors/locations.executor";
import { detectFile } from "../../app/usecases/import/import-detector";
import { newReport } from "../../app/usecases/import/import.types";

const HEADER =
  "Id,Initials,Description,HasStock,CreatedAt,UpdatedAt,Level,IdentifycationType,ParentId,CompanyId,InitialsOrdered,OldId,DescriptionPath,HierarchyPath,InitialsPath,DepthCm,HeightCm,VolumeM3,WidthCm,MaxQuantity,SortPosition";

function locationsCsv(lines: string[]) {
  return detectFile({
    fieldname: "file",
    filename: "locations.csv",
    buffer: Buffer.from([HEADER, ...lines].join("\n"), "utf8"),
  });
}

function makeDeps() {
  const created: Array<{ code: string; maxCapacity: number; parentId?: string }> = [];
  let seq = 0;
  const deps: LocationExecDeps = {
    locationUseCase: {
      create: vi.fn(
        async (data: { code: string; maxCapacity: number; parentId?: string }) => {
          created.push({
            code: data.code,
            maxCapacity: data.maxCapacity,
            parentId: data.parentId,
          });
          return { id: `loc-${++seq}`, code: data.code } as never;
        },
      ),
    },
    loadExistingCodes: vi.fn(async () => []),
  };
  return { deps, created };
}

describe("import/wd-locations — árvore do locations.csv", () => {
  // Filho declarado ANTES do pai no CSV (Level resolve a ordem).
  const CSV = [
    // guid,Initials,Description,...,Level,...,ParentId,...,InitialsPath,...,MaxQuantity
    "g-caixa,CAIXA 22,Caixa 22,t,,,2,BOX,g-galpao,251,,,,,GALPÃO > CAIXA 22,,,,,15,",
    "g-galpao,GALPÃO,Galpão principal,t,,,1,ROOM,,251,,,,,GALPÃO,,,,,0,",
    "g-orfa,ORFA,Sem pai,t,,,3,BOX,g-inexistente,251,,,,,ORFA,,,,,,",
  ];

  it("mapper: Level asc, code=normPath(InitialsPath), MaxQuantity→maxCapacity, GUID→code", () => {
    const r = mapWdLocations(locationsCsv(CSV));
    expect(r.items.map((i) => i.code)).toEqual([
      "GALPÃO",
      "GALPÃO > CAIXA 22",
      "ORFA",
    ]);
    const caixa = r.items[1];
    expect(caixa.parentCode).toBe("GALPÃO");
    expect(caixa.maxCapacity).toBe(15); // gap do script corrigido
    expect(r.items[0].maxCapacity).toBe(0);
    expect(r.guidToCode.get("g-caixa")).toBe("GALPÃO > CAIXA 22");
    // Pai inexistente → raiz + aviso.
    expect(r.items[2].parentCode).toBeNull();
    expect(r.avisos.some((a) => a.motivo.includes("ParentId"))).toBe(true);
  });

  it("executor: pais antes dos filhos, parentId encadeado, capacidade gravada", async () => {
    const { deps, created } = makeDeps();
    const report = newReport("WEBDESMONTE", "LOCALIZACOES", "admin-1", false);
    const mapped = mapWdLocations(locationsCsv(CSV));
    await executeLocationPlan(
      { targetUserId: "admin-1", files: [], dryRun: false },
      report,
      mapped.items,
      deps,
    );
    expect(created[0]).toEqual({
      code: "GALPÃO",
      maxCapacity: 0,
      parentId: undefined,
    });
    expect(created[1].code).toBe("GALPÃO > CAIXA 22");
    expect(created[1].parentId).toBe("loc-1");
    expect(created[1].maxCapacity).toBe(15);
    expect(report.contadores.criadas).toBe(3);
  });

  it("runner: idempotência (códigos já existentes = 0 criações)", async () => {
    const deps: LocationExecDeps = {
      locationUseCase: { create: vi.fn() },
      loadExistingCodes: vi.fn(async () => [
        { id: "a", code: "GALPÃO" },
        { id: "b", code: "GALPÃO > CAIXA 22" },
        { id: "c", code: "ORFA" },
      ]),
    };
    const report = await runWdLocations(
      { targetUserId: "admin-1", files: [locationsCsv(CSV)], dryRun: false },
      deps,
    );
    expect(deps.locationUseCase.create).not.toHaveBeenCalled();
    expect(report.contadores.ja_existiam).toBe(3);
  });
});
