import { describe, it, expect, vi } from "vitest";
import XLSX from "xlsx";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    scrap: { findMany: vi.fn(async () => []) },
    location: { findMany: vi.fn(async () => []) },
  },
}));

import {
  mapVaaptScraps,
  mapWdScraps,
} from "../../app/usecases/import/mappers/sucatas.mapper";
import {
  executeScrapsPlan,
  runWdScraps,
  type ScrapsExecDeps,
} from "../../app/usecases/import/executors/scraps.executor";
import { detectFile } from "../../app/usecases/import/import-detector";
import { newReport } from "../../app/usecases/import/import.types";
import type { ImportContext } from "../../app/usecases/import/import.types";
import type { ScrapCreate } from "../../app/interfaces/scrap.interface";

function veiculosXlsx(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["# Codigo Veiculo", "Marca", "Modelo", "Chassi", "Placa", "Apelido", "Cor", "Ano modelo", "Valor da compra"],
      ...rows,
    ]),
    "Planilha1",
  );
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return detectFile({ fieldname: "file", filename: "veiculos.xlsx", buffer });
}

const WD_HEADER =
  "Id,AccessKey,CertidaoBaixaVeiculo,Lot,NfeNumber,Brand,Model,LicensePlate,Chassis,Year,Color,PurchaseValue,LocationId,Ncm,NfeSeries,Renavam,EntryDate,EngineNumber,InfoAdd";

function wdCsv(lines: string[]) {
  return detectFile({
    fieldname: "file",
    filename: "purchase_waste.csv",
    buffer: Buffer.from([WD_HEADER, ...lines].join("\n"), "utf8"),
  });
}

function makeDeps(
  existing: Array<{
    id: string;
    notes?: string | null;
    plate?: string | null;
    chassis?: string | null;
  }> = [],
  locationCodes: Array<{ id: string; code: string }> = [],
) {
  const created: ScrapCreate[] = [];
  const deps: ScrapsExecDeps = {
    scrapUseCase: {
      create: vi.fn(async (data: ScrapCreate) => {
        created.push(data);
        return { id: `scrap-${created.length}` } as never;
      }),
    },
    loadExistingScraps: vi.fn(async () =>
      existing.map((e) => ({
        id: e.id,
        notes: e.notes ?? null,
        plate: e.plate ?? null,
        chassis: e.chassis ?? null,
      })),
    ),
    loadLocationCodes: vi.fn(async () => locationCodes),
  };
  return { deps, created };
}

const ctx = (dryRun: boolean): ImportContext => ({
  targetUserId: "admin-1",
  files: [],
  dryRun,
});

describe("import/sucatas — mapper Vaapt (Backup Veiculos)", () => {
  it("chassi inválido NÃO derruba a linha: grava sem chassi + aviso", () => {
    const r = mapVaaptScraps(
      veiculosXlsx([
        ["36", "VW", "GOL", "9BWAG4124FT592152", "abc-1234", "Golzinho", "PRETO", "2010", "1.500,00"],
        ["37", "FIAT", "UNO", "CHASSICURTO", null, null, null, "2008", null],
      ]),
    );
    expect(r.items).toHaveLength(2);
    expect(r.items[0].chassis).toBe("9BWAG4124FT592152");
    expect(r.items[0].plate).toBe("ABC1234");
    expect(r.items[0].cost).toBe(1500);
    expect(r.items[0].notes).toContain("veículo #36");
    expect(r.items[1].chassis).toBeNull(); // 11 chars ≠ 17 → null
    expect(r.avisos.some((a) => a.motivo.includes("Chassi"))).toBe(true);
  });

  it("brand/model ausentes viram INDEFINIDO (obrigatórios no usecase)", () => {
    const r = mapVaaptScraps(veiculosXlsx([["38", null, null, null, null, null, null, null, null]]));
    expect(r.items[0].brand).toBe("INDEFINIDO");
    expect(r.items[0].model).toBe("INDEFINIDO");
  });
});

describe("import/sucatas — mapper WebDesmonte (purchase_waste.csv)", () => {
  it("mapeia os campos fiscais e resolve LocationId GUID→code", () => {
    const guidToCode = new Map([["g-loc", "GALPÃO > CAIXA 22"]]);
    const r = mapWdScraps(
      wdCsv([
        `pw1,${"1".repeat(43)}5,CERT-9,L001,123,VW,GOL,ABC1234,9BWAG4124FT592152,2010,PRETO,"1.234,56",g-loc,8708,1,999,2024-05-31,M123,obs extra`,
      ]),
      guidToCode,
    );
    const s = r.items[0];
    expect(s.accessKey).toBe(`${"1".repeat(43)}5`);
    expect(s.deregistrationCert).toBe("CERT-9");
    expect(s.lot).toBe("L001");
    expect(s.nfeNumber).toBe("123");
    expect(s.nfeSeries).toBe("1");
    expect(s.renavam).toBe("999");
    expect(s.engineNumber).toBe("M123");
    expect(s.cost).toBe(1234.56);
    expect(s.entryDate?.toISOString().slice(0, 10)).toBe("2024-05-31");
    expect(s.locationCode).toBe("GALPÃO > CAIXA 22");
    expect(s.notes).toContain("sucata #pw1");
    expect(s.notes).toContain("lote L001");
  });

  it("chave de acesso inválida vira null + aviso (linha não cai)", () => {
    const r = mapWdScraps(wdCsv(["pw2,12345,,,,VW,GOL,,,,,,,,,,,,"]), undefined);
    expect(r.items[0].accessKey).toBeNull();
    expect(r.avisos.some((a) => a.motivo.includes("Chave de acesso"))).toBe(true);
  });

  it("LocationId sem locations.csv junto → aviso de vínculo não resolvido", () => {
    const r = mapWdScraps(wdCsv(["pw3,,,,,VW,GOL,,,,,,g-loc,,,,,,"]), undefined);
    expect(r.items[0].locationCode).toBeNull();
    expect(r.avisos.some((a) => a.motivo.includes("locations.csv"))).toBe(true);
  });
});

describe("import/sucatas — executor", () => {
  const items = () =>
    mapVaaptScraps(
      veiculosXlsx([
        ["36", "VW", "GOL", "9BWAG4124FT592152", "ABC1234", null, null, "2010", "1000"],
        ["37", "FIAT", "UNO", null, "XYZ9876", null, null, "2008", "500"],
      ]),
    ).items;

  it("PRÉVIA não cria nada; APPLY cria com DISMANTLED e devolve o mapa cod→id", async () => {
    const { deps } = makeDeps();
    const report = newReport("VAAPT", "SUCATAS", "admin-1", true);
    const map = await executeScrapsPlan(ctx(true), report, items(), deps);
    expect(deps.scrapUseCase.create).not.toHaveBeenCalled();
    expect(report.contadores.a_criar).toBe(2);
    expect(map.get("36")).toContain("dry");

    const { deps: deps2, created } = makeDeps();
    const report2 = newReport("VAAPT", "SUCATAS", "admin-1", false);
    const map2 = await executeScrapsPlan(ctx(false), report2, items(), deps2);
    expect(created).toHaveLength(2);
    expect(created[0].logisticsStatus).toBe("DISMANTLED");
    expect(created[0].status).toBe("AVAILABLE");
    expect(map2.get("36")).toBe("scrap-1");
  });

  it("marker existente (novo ou Legado) deduplica e reaproveita o id", async () => {
    const { deps, created } = makeDeps([
      { id: "s-old", notes: "Legado 704 · veículo #36" },
    ]);
    const report = newReport("VAAPT", "SUCATAS", "admin-1", false);
    const map = await executeScrapsPlan(ctx(false), report, items(), deps);
    expect(report.contadores.ja_existiam_marker).toBe(1);
    expect(map.get("36")).toBe("s-old");
    expect(created).toHaveLength(1); // só o #37
  });

  it("placa/chassi já existentes SEM marker → skip com aviso (possível duplicata)", async () => {
    const { deps, created } = makeDeps([
      { id: "s-x", chassis: "9BWAG4124FT592152" },
    ]);
    const report = newReport("VAAPT", "SUCATAS", "admin-1", false);
    const map = await executeScrapsPlan(ctx(false), report, items(), deps);
    expect(report.contadores.ja_existiam_placa_chassi).toBe(1);
    expect(report.avisos.some((a) => a.motivo.includes("possível duplicata"))).toBe(true);
    expect(map.get("36")).toBe("s-x"); // reaproveita p/ vínculo
    expect(created).toHaveLength(1);
  });

  it("runner WD resolve locationId pelo code e passa ao create", async () => {
    const locations = locationsFixture();
    const { deps, created } = makeDeps([], [{ id: "loc-9", code: "GALPÃO > CAIXA 22" }]);
    const report = await runWdScraps(
      {
        targetUserId: "admin-1",
        files: [
          wdCsv([`pw1,,,,,VW,GOL,ABC1234,,2010,,,g-loc,,,,,,`]),
          locations,
        ],
        dryRun: false,
      },
      deps,
    );
    expect(report.contadores.criadas).toBe(1);
    expect(created[0].locationId).toBe("loc-9");
  });
});

function locationsFixture() {
  const header =
    "Id,Initials,Description,HasStock,CreatedAt,UpdatedAt,Level,IdentifycationType,ParentId,CompanyId,InitialsOrdered,OldId,DescriptionPath,HierarchyPath,InitialsPath,DepthCm,HeightCm,VolumeM3,WidthCm,MaxQuantity,SortPosition";
  const line = "g-loc,CAIXA 22,Caixa,t,,,2,BOX,,251,,,,,GALPÃO > CAIXA 22,,,,,0,";
  return detectFile({
    fieldname: "locations",
    filename: "locations.csv",
    buffer: Buffer.from([header, line].join("\n"), "utf8"),
  });
}
