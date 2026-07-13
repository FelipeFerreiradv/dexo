import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    nfeEmitida: { findMany: vi.fn(async () => []) },
    nfeSequence: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
  },
}));

import { mapIbrNfes } from "../../app/usecases/import/mappers/ibr-nfes.mapper";
import {
  runIbrNfes,
  type NfeImportDeps,
} from "../../app/usecases/import/nfe-import.usecase";
import { detectFile } from "../../app/usecases/import/import-detector";
import type { ImportContext } from "../../app/usecases/import/import.types";
import type { NfeHistoricCreate } from "../../app/repositories/nfe.repository";

const HEADER =
  "NotaFiscalId,NumeroNotaFiscal,Serie,ChaveDeAcesso,DataEmissao,UpdatedAt,NomeDestinatario,CustomerId,ValorTotal,Status,TipoNF,Protocolo,NumeroEvento,ProtocoloCancelada,ProtocoloEstornada,NaturezaOperacao,UrlXmlNFAutorizada,UrlXmlNFCancelada,UrlXmlNFCorrigida,UrlXmlNfEstornada,SaleId";

// Chaves: CNPJ Ribeiro em [6,20), série 001 em [22,25).
const CH = (num: string) =>
  `41230613871087000114550010000${num.padStart(5, "0")}1532213490`;

function nfeCsv(lines: string[]) {
  return detectFile({
    fieldname: "file",
    filename: "nfe_emitidas.csv",
    buffer: Buffer.from([HEADER, ...lines].join("\n"), "utf8"),
  });
}

function row(over: Partial<Record<string, string>> = {}) {
  const d: Record<string, string> = {
    NotaFiscalId: "53025",
    NumeroNotaFiscal: "1413",
    Serie: "1",
    ChaveDeAcesso: CH("1413"),
    DataEmissao: "2023-06-21 17:06:48",
    UpdatedAt: "",
    NomeDestinatario: "MARIA RIBEIRO",
    CustomerId: "127450",
    ValorTotal: "40",
    Status: "0",
    TipoNF: "1",
    Protocolo: "141230158178751",
    NumeroEvento: "",
    ProtocoloCancelada: "",
    ProtocoloEstornada: "",
    NaturezaOperacao: "Venda de Mercadoria",
    UrlXmlNFAutorizada: "http://x/a.xml",
    UrlXmlNFCancelada: "",
    UrlXmlNFCorrigida: "",
    UrlXmlNfEstornada: "",
    SaleId: "",
    ...over,
  };
  return [
    d.NotaFiscalId, d.NumeroNotaFiscal, d.Serie, d.ChaveDeAcesso, d.DataEmissao,
    d.UpdatedAt, d.NomeDestinatario, d.CustomerId, d.ValorTotal, d.Status,
    d.TipoNF, d.Protocolo, d.NumeroEvento, d.ProtocoloCancelada,
    d.ProtocoloEstornada, d.NaturezaOperacao, d.UrlXmlNFAutorizada,
    d.UrlXmlNFCancelada, d.UrlXmlNFCorrigida, d.UrlXmlNfEstornada, d.SaleId,
  ].join(",");
}

function makeDeps() {
  const created: NfeHistoricCreate[] = [];
  const seqCalls: Array<{ serie: number; novo: number }> = [];
  const deps: NfeImportDeps = {
    createHistoric: vi.fn(async (data: NfeHistoricCreate) => {
      created.push(data);
      return { id: `nfe-${created.length}` };
    }),
    loadExisting: vi.fn(async () => []),
    ajustarProximoNumero: vi.fn(async (_u, _a, serie, novo) => {
      seqCalls.push({ serie, novo });
    }),
  };
  return { deps, created, seqCalls };
}

const ctx = (dryRun: boolean, file: ReturnType<typeof nfeCsv>): ImportContext => ({
  targetUserId: "admin-1",
  files: [file],
  dryRun,
});

describe("import/ibr-nfe — mapper", () => {
  it("Status 0/2 → AUTHORIZED, 1 → CANCELLED; TipoNF 1→SAIDA, 0→ENTRADA; série da chave", () => {
    const r = mapIbrNfes(
      nfeCsv([
        row({ NumeroNotaFiscal: "1413", Status: "0", TipoNF: "1" }),
        row({ NumeroNotaFiscal: "1500", Status: "1", TipoNF: "1", ChaveDeAcesso: CH("1500") }),
        row({ NumeroNotaFiscal: "2470", Status: "2", TipoNF: "0", ChaveDeAcesso: CH("2470"), NaturezaOperacao: "Devolucao de Mercadoria" }),
      ]),
    );
    expect(r.items).toHaveLength(3);
    const byNum = Object.fromEntries(r.items.map((i) => [i.numero, i]));
    expect(byNum[1413].status).toBe("AUTHORIZED");
    expect(byNum[1413].serie).toBe(1); // da chave
    expect(byNum[1413].tipoOperacao).toBe("SAIDA");
    expect(byNum[1413].cnpjEmitente).toBe("13871087000114");
    expect(byNum[1500].status).toBe("CANCELLED");
    expect(byNum[2470].status).toBe("AUTHORIZED"); // 2 = válida
    expect(byNum[2470].tipoOperacao).toBe("ENTRADA");
    expect(byNum[2470].naturezaOperacao).toBe("Devolucao de Mercadoria");
    expect(r.porStatus).toMatchObject({ AUTHORIZED: 2, CANCELLED: 1 });
  });

  it("dedup por (série, número): mesmo número em séries distintas NÃO colapsa", () => {
    // Nº 100 na série 1 (chave …55**001**…) e na série 2 (…55**002**…).
    const ch1 = `41230613871087000114550010000${"100".padStart(5, "0")}1532213490`;
    const ch2 = `41230613871087000114550020000${"100".padStart(5, "0")}1532213490`;
    const r = mapIbrNfes(
      nfeCsv([
        row({ NumeroNotaFiscal: "100", Serie: "1", ChaveDeAcesso: ch1 }),
        row({ NumeroNotaFiscal: "100", Serie: "2", ChaveDeAcesso: ch2 }),
      ]),
    );
    expect(r.items).toHaveLength(2);
    expect(r.items.map((i) => i.serie).sort()).toEqual([1, 2]);
    expect(r.duplicadosColapsados).toBe(0);
  });
});

describe("import/ibr-nfe — runner (reusa createHistoric)", () => {
  const FILE = () =>
    nfeCsv([
      row({ NumeroNotaFiscal: "1413", ValorTotal: "40", NomeDestinatario: "MARIA" }),
      row({ NumeroNotaFiscal: "1500", ChaveDeAcesso: CH("1500"), ValorTotal: "100", Status: "1" }),
    ]);

  it("PRÉVIA não escreve nem ajusta sequência", async () => {
    const { deps, created, seqCalls } = makeDeps();
    const report = await runIbrNfes(ctx(true, FILE()), deps);
    expect(created).toEqual([]);
    expect(seqCalls).toEqual([]);
    expect(report.contadores.a_criar).toBe(2);
  });

  it("APPLY grava histórico com shapes da listagem e avança sequência p/ max+1", async () => {
    const { deps, created, seqCalls } = makeDeps();
    const report = await runIbrNfes(ctx(false, FILE()), deps);
    expect(created).toHaveLength(2);
    const n = created.find((c) => c.numero === 1413)!;
    expect(n.status).toBe("AUTHORIZED");
    expect(n.ambiente).toBe("PRODUCAO");
    expect(n.destinatarioJson).toEqual({ tipoPessoa: "PJ", cpfCnpj: "", nome: "MARIA" });
    expect(n.totaisJson).toMatchObject({ totalNota: 40 });
    expect(n.emitenteJson).toEqual({ cnpj: "13871087000114" });
    expect(n.informacoesComplementares).toContain("IBR");
    // Sequência avança para 1501 (max 1500 + 1).
    expect(seqCalls).toEqual([{ serie: 1, novo: 1501 }]);
    expect(report.contadores.criadas).toBe(2);
  });

  it("idempotência: dedup por chave/número; 2ª rodada = 0 criações", async () => {
    const { deps, created } = makeDeps();
    deps.loadExisting = vi.fn(async () => [
      { serie: 1, numero: 1413, chaveAcesso: CH("1413") },
      { serie: 1, numero: 1500, chaveAcesso: CH("1500") },
    ]);
    const report = await runIbrNfes(ctx(false, FILE()), deps);
    expect(created).toEqual([]);
    expect(report.contadores.ja_existiam).toBe(2);
  });
});
