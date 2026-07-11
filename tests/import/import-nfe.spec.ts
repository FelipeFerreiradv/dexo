import { describe, it, expect, vi } from "vitest";
import XLSX from "xlsx";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    nfeEmitida: { findMany: vi.fn(async () => []) },
    nfeSequence: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
  },
}));

import {
  mapVaaptNfes,
  mapNfeStatus,
  cfopDerive,
} from "../../app/usecases/import/mappers/vaapt-nfes.mapper";
import {
  runVaaptNfes,
  type NfeImportDeps,
} from "../../app/usecases/import/nfe-import.usecase";
import { detectFile } from "../../app/usecases/import/import-detector";
import type { ImportContext } from "../../app/usecases/import/import.types";
import type { NfeHistoricCreate } from "../../app/repositories/nfe.repository";

// Chave válida de 44 dígitos: CNPJ em [6,20) e SÉRIE em [22,25).
const CHAVE_33 = "42240112345678000195550010000000331000000001";

/** Workbook no formato REAL invoicy: R0=título, R1 vazia, R2=rótulos. */
function nfeXlsx(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Relatório de Notas Fiscal Emitidas"],
      [],
      [
        "Cod Nota Fiscal",
        "N° NFe",
        "Status da NFe",
        "Motivo do cancelamento",
        "CFOP",
        "Nome do Cliente",
        "Data de Emissão",
        "Data de Autorização",
        "Valor Total da NFe",
        "Chave de Acesso",
      ],
      ...rows,
    ]),
    "Java Books",
  );
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xls" }) as Buffer;
  return detectFile({ fieldname: "file", filename: "notas.xls", buffer });
}

function makeDeps(
  existing: Array<{ serie: number; numero: number; chaveAcesso: string | null }> = [],
  opts: { seqJaAFrente?: boolean } = {},
) {
  const created: NfeHistoricCreate[] = [];
  const seqCalls: Array<{ serie: number; novo: number }> = [];
  const deps: NfeImportDeps = {
    createHistoric: vi.fn(async (data: NfeHistoricCreate) => {
      created.push(data);
      return { id: `nfe-${created.length}` };
    }),
    loadExisting: vi.fn(async () => existing),
    ajustarProximoNumero: vi.fn(async (_u, _a, serie, novo) => {
      if (opts.seqJaAFrente) {
        throw new Error(`Novo número (${novo}) deve ser maior que o atual (999)`);
      }
      seqCalls.push({ serie, novo });
    }),
  };
  return { deps, created, seqCalls };
}

const ctx = (dryRun: boolean, file: ReturnType<typeof nfeXlsx>): ImportContext => ({
  targetUserId: "admin-1",
  files: [file],
  dryRun,
});

describe("import/nfe — mapper (paridade com migracao-vaapt-nfes)", () => {
  it("colapsa números repetidos pela prioridade de status e deriva série/CNPJ da chave", () => {
    const file = nfeXlsx([
      // nº 33 reemitido: Negada primeiro, Autorizada depois → vence a Autorizada.
      ["1", "33", "Negada", null, "5102", "MARIA", "01/05/2024", null, "100,00", ""],
      ["2", "33", "Autorizada", null, "5102", "MARIA", "31/05/2024", "31/05/2024", "150,00", CHAVE_33],
      ["3", "34", "Cancelada", "erro de digitação", "6102", "JOSÉ", "01/06/2024", "01/06/2024", "200,00", ""],
    ]);
    const r = mapVaaptNfes(file);
    expect(r.items).toHaveLength(2);
    expect(r.duplicadosColapsados).toBe(1);

    const n33 = r.items[0];
    expect(n33.numero).toBe(33);
    expect(n33.status).toBe("AUTHORIZED");
    expect(n33.valor).toBe(150);
    expect(n33.serie).toBe(1); // da chave, slice(22,25)
    expect(n33.cnpjEmitente).toBe("12345678000195"); // da chave, slice(6,20)
    expect(n33.chaveAcesso).toBe(CHAVE_33);
    expect(n33.destinoOperacao).toBe("INTERNA"); // CFOP 5xxx

    const n34 = r.items[1];
    expect(n34.status).toBe("CANCELLED");
    expect(n34.serie).toBe(1); // sem chave → série 1
    expect(n34.destinoOperacao).toBe("INTERESTADUAL"); // CFOP 6xxx
    expect(n34.informacoesComplementares).toContain("motivo: erro de digitação");
  });

  it("'Cancelamento negado' permanece AUTHORIZED; CFOP deriva tipo/destino", () => {
    expect(mapNfeStatus("Cancelamento negado")).toBe("AUTHORIZED");
    expect(mapNfeStatus("Inutilizado")).toBe("INUTILIZED");
    expect(cfopDerive("1102")).toEqual({ tipo: "ENTRADA", destino: "INTERNA" });
    expect(cfopDerive("7102")).toEqual({ tipo: "SAIDA", destino: "EXTERIOR" });
  });

  it("chave inválida vira aviso e nota entra sem chave", () => {
    const file = nfeXlsx([
      ["1", "40", "Autorizada", null, "5102", "ANA", "01/05/2024", null, "50", "123"],
    ]);
    const r = mapVaaptNfes(file);
    expect(r.items[0].chaveAcesso).toBeNull();
    expect(r.semChave).toBe(1);
    expect(r.avisos.some((a) => a.motivo.includes("chave de acesso"))).toBe(true);
  });
});

describe("import/nfe — executor (histórico, nunca SEFAZ)", () => {
  const FILE = () =>
    nfeXlsx([
      ["1", "33", "Autorizada", null, "5102", "MARIA", "31/05/2024", "31/05/2024", "150,00", CHAVE_33],
      ["2", "34", "Autorizada", null, "5102", "JOSÉ", "01/06/2024", "01/06/2024", "200,00", ""],
    ]);

  it("PRÉVIA não escreve nem ajusta sequência", async () => {
    const { deps, created, seqCalls } = makeDeps();
    const report = await runVaaptNfes(ctx(true, FILE()), deps);
    expect(created).toHaveLength(0);
    expect(seqCalls).toHaveLength(0);
    expect(report.contadores.a_criar).toBe(2);
    expect(report.avisos.some((a) => a.motivo.includes("será ajustada para 35"))).toBe(true);
  });

  it("APPLY grava histórico com shapes da listagem e avança a sequência para max+1", async () => {
    const { deps, created, seqCalls } = makeDeps();
    const report = await runVaaptNfes(ctx(false, FILE()), deps);
    expect(created).toHaveLength(2);
    const n33 = created[0];
    expect(n33.status).toBe("AUTHORIZED");
    expect(n33.ambiente).toBe("PRODUCAO");
    expect(n33.destinatarioJson).toEqual({
      tipoPessoa: "PJ",
      cpfCnpj: "",
      nome: "MARIA",
    });
    expect(n33.totaisJson).toMatchObject({ totalNota: 150, totalProdutos: 150 });
    expect(n33.emitenteJson).toEqual({ cnpj: "12345678000195" });
    expect(seqCalls).toEqual([{ serie: 1, novo: 35 }]);
    expect(report.contadores.criadas).toBe(2);
    expect(report.contadores.sequencias_ajustadas).toBe(1);
  });

  it("dedup por chave e por série/número (idempotência); sequência já à frente = no-op", async () => {
    const { deps, created } = makeDeps(
      [
        { serie: 1, numero: 33, chaveAcesso: CHAVE_33 },
        { serie: 1, numero: 34, chaveAcesso: null },
      ],
      { seqJaAFrente: true },
    );
    const report = await runVaaptNfes(ctx(false, FILE()), deps);
    expect(created).toHaveLength(0);
    expect(report.contadores.ja_existiam).toBe(2);
    expect(report.contadores.sequencias_ja_a_frente).toBe(1);
    expect(report.contadores.erros ?? 0).toBe(0);
  });

  it("P2002 do banco (corrida) vira skip, não erro", async () => {
    const { deps } = makeDeps();
    const { Prisma } = await import("@prisma/client");
    (deps.createHistoric as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "x",
      }),
    );
    const report = await runVaaptNfes(ctx(false, FILE()), deps);
    expect(report.contadores.ja_existiam).toBe(1);
    expect(report.contadores.criadas).toBe(1);
    expect(report.contadores.erros ?? 0).toBe(0);
  });
});
