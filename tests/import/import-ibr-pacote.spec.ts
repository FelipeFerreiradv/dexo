import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    location: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    product: { findMany: vi.fn(async () => []) },
    nfeEmitida: { findMany: vi.fn(async () => []) },
    nfeSequence: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
  },
}));

import {
  runIbrPacote,
  type IbrPacoteDeps,
} from "../../app/usecases/import/executors/ibr-pacote.executor";
import { detectFile } from "../../app/usecases/import/import-detector";
import type {
  ImportContext,
  DetectedFile,
} from "../../app/usecases/import/import.types";
import type { IbrEstoqueDeps } from "../../app/usecases/import/executors/ibr-estoque.executor";
import type { NfeImportDeps } from "../../app/usecases/import/nfe-import.usecase";
import type { ProductCreate } from "../../app/interfaces/product.interface";
import type { NfeHistoricCreate } from "../../app/repositories/nfe.repository";

/* ------------------------------- Fixtures ------------------------------- */

const ESTOQUE_HEADER =
  "ProductId,SKU,BarCode,Description,Brand,Model,Active,QuantidadeEstoque,EstoqueMinimo,CustoAtual,CustoReal,ValorVenda,Ncm,Cest,LocationId,LocalizacaoSiglas,LocalizacaoDescricao,CreatedAt,UpdatedAt";

function estoqueCsv(lines: string[]): DetectedFile {
  return detectFile({
    fieldname: "file",
    filename: "estoque.csv",
    buffer: Buffer.from([ESTOQUE_HEADER, ...lines].join("\n"), "utf8"),
  });
}

const NFE_HEADER =
  "NotaFiscalId,NumeroNotaFiscal,Serie,ChaveDeAcesso,DataEmissao,UpdatedAt,NomeDestinatario,CustomerId,ValorTotal,Status,TipoNF,Protocolo,NumeroEvento,ProtocoloCancelada,ProtocoloEstornada,NaturezaOperacao,UrlXmlNFAutorizada,UrlXmlNFCancelada,UrlXmlNFCorrigida,UrlXmlNfEstornada,SaleId";

// Chave: CNPJ Ribeiro em [6,20), série 001 em [22,25).
const CH = (num: string) =>
  `41230613871087000114550010000${num.padStart(5, "0")}1532213490`;

function nfeCsv(lines: string[]): DetectedFile {
  return detectFile({
    fieldname: "file",
    filename: "nfe_emitidas.csv",
    buffer: Buffer.from([NFE_HEADER, ...lines].join("\n"), "utf8"),
  });
}

function nfeRow(num: string, over: Partial<Record<string, string>> = {}) {
  const d: Record<string, string> = {
    NotaFiscalId: `id-${num}`,
    NumeroNotaFiscal: num,
    Serie: "1",
    ChaveDeAcesso: CH(num),
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

/* ---------------------------------- Deps -------------------------------- */

interface ExistingRef {
  id: string;
  sku: string;
  skuNormalized: string | null;
  locationId: string | null;
}

function makeEstoqueDeps(existing: ExistingRef[] = []) {
  const created: ProductCreate[] = [];
  const attachCalls: Array<{ locationId: string; ids: string[] }> = [];
  let locSeq = 0;
  const deps: IbrEstoqueDeps = {
    locations: {
      locationUseCase: {
        createLean: vi.fn(async (dd: { code: string; parentId?: string }) => {
          return { id: `loc-${++locSeq}`, code: dd.code } as never;
        }),
      },
      loadExistingCodes: vi.fn(async () => []),
    },
    productUseCase: {
      create: vi.fn(async (data: ProductCreate) => {
        created.push(data);
        return { id: `p-${created.length}` } as never;
      }),
    },
    loadProductsBySkuNormalized: vi.fn(async (_u, norms: string[]) => [
      ...existing.filter((e) => e.skuNormalized && norms.includes(e.skuNormalized)),
      ...existing.filter((e) => e.skuNormalized === null),
    ]),
    attachProducts: vi.fn(async (locationId: string, ids: string[]) => {
      attachCalls.push({ locationId, ids });
      return {
        attached: ids.map((id) => ({ id, sku: id, name: id })),
        alreadyAttached: [],
        skipped: [],
        location: { id: locationId, code: locationId, productsCount: ids.length, maxCapacity: 0 },
      };
    }) as IbrEstoqueDeps["attachProducts"],
  };
  return { deps, created, attachCalls };
}

function makeNfeDeps() {
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

function makeDeps(existing: ExistingRef[] = []) {
  const est = makeEstoqueDeps(existing);
  const nfe = makeNfeDeps();
  const deps: IbrPacoteDeps = { estoque: est.deps, nfe: nfe.deps };
  return { deps, est, nfe };
}

const ctx = (dryRun: boolean, files: DetectedFile[]): ImportContext => ({
  targetUserId: "admin-1",
  files,
  dryRun,
});

const ESTOQUE = () =>
  estoqueCsv([
    '100,2492,,Farol,Ford,KA,t,3,0,0.01,15.5,160,8708,,,"BARR. > CX 1",Barracao,,',
    '101,9999,,Novo,Fiat,Uno,t,1,0,0.01,0.01,90,,,,"BARR. > CX 2",,,',
  ]);
const NFE = () => nfeCsv([nfeRow("1413"), nfeRow("1500", { ValorTotal: "100" })]);

/* --------------------------------- Testes ------------------------------- */

describe("import/ibr-pacote — composição estoque + NF-e", () => {
  it("PRÉVIA (dryRun) não escreve nada em nenhuma fase", async () => {
    const { deps, est, nfe } = makeDeps();
    const report = await runIbrPacote(ctx(true, [ESTOQUE(), NFE()]), deps);

    expect(est.created).toEqual([]);
    expect(est.attachCalls).toEqual([]);
    expect(nfe.created).toEqual([]);
    expect(nfe.seqCalls).toEqual([]);
    // As duas fases aparecem no relatório.
    expect(Object.keys(report.porFase ?? {}).sort()).toEqual(["estoque", "nfe"]);
    expect(report.porFase?.nfe.contadores.a_criar).toBe(2);
  });

  it("APPLY roda as duas fases: cria produto faltante E grava NF-e histórica", async () => {
    // 2492 já existe (só vincula); 9999 é criado.
    const { deps, est, nfe } = makeDeps([
      { id: "p-exist", sku: "2492", skuNormalized: "2492", locationId: null },
    ]);
    const report = await runIbrPacote(ctx(false, [ESTOQUE(), NFE()]), deps);

    // Estoque: 1 criado (9999), 1 vinculado (2492).
    expect(est.created.map((c) => c.sku)).toEqual(["9999"]);
    expect(est.attachCalls).toHaveLength(1);
    // NF-e: 2 históricas gravadas + sequência avançada p/ max+1.
    expect(nfe.created.map((c) => c.numero).sort()).toEqual([1413, 1500]);
    expect(nfe.seqCalls).toEqual([{ serie: 1, novo: 1501 }]);

    // Roll-up de destaques no topo do pacote.
    expect(report.contadores.produtos_criados).toBe(1);
    expect(report.contadores.produtos_vinculados).toBe(1);
    expect(report.contadores.nfe_criadas).toBe(2);
    expect(report.contadores.erros ?? 0).toBe(0);
  });

  it("PARCIAL: só estoque.csv → roda produtos, pula NF-e (sem erro)", async () => {
    const { deps, est, nfe } = makeDeps();
    const report = await runIbrPacote(ctx(false, [ESTOQUE()]), deps);

    expect(est.created).toHaveLength(2); // ambos faltantes → criados
    expect(nfe.created).toEqual([]);
    expect(Object.keys(report.porFase ?? {})).toEqual(["estoque"]);
    expect(report.porFase?.nfe).toBeUndefined();
  });

  it("PARCIAL: só nfe_emitidas.csv → roda NF-e, pula produtos (sem erro)", async () => {
    const { deps, est, nfe } = makeDeps();
    const report = await runIbrPacote(ctx(false, [NFE()]), deps);

    expect(nfe.created).toHaveLength(2);
    expect(est.created).toEqual([]);
    expect(Object.keys(report.porFase ?? {})).toEqual(["nfe"]);
    expect(report.porFase?.estoque).toBeUndefined();
  });

  it("idempotência: 2ª rodada (tudo já existe) não cria nada", async () => {
    const { deps, est, nfe } = makeDeps([
      { id: "p1", sku: "2492", skuNormalized: "2492", locationId: "loc-1" },
      { id: "p2", sku: "9999", skuNormalized: "9999", locationId: "loc-2" },
    ]);
    est.deps.locations.loadExistingCodes = vi.fn(async () => [
      { id: "locB", code: "BARR." },
      { id: "loc-1", code: "BARR. > CX 1" },
      { id: "loc-2", code: "BARR. > CX 2" },
    ]);
    nfe.deps.loadExisting = vi.fn(async () => [
      { serie: 1, numero: 1413, chaveAcesso: CH("1413") },
      { serie: 1, numero: 1500, chaveAcesso: CH("1500") },
    ]);
    const report = await runIbrPacote(ctx(false, [ESTOQUE(), NFE()]), deps);

    expect(est.created).toEqual([]);
    expect(est.attachCalls).toEqual([]);
    expect(nfe.created).toEqual([]);
    expect(report.contadores.produtos_criados ?? 0).toBe(0);
    expect(report.contadores.nfe_criadas ?? 0).toBe(0);
    expect(report.contadores.nfe_ja_existiam).toBe(2);
  });

  it("nenhum arquivo reconhecido do pacote → erro claro", async () => {
    const { deps } = makeDeps();
    await expect(runIbrPacote(ctx(false, []), deps)).rejects.toThrow(
      /ao menos um CSV do export IBR/i,
    );
  });
});
