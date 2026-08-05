import { describe, it, expect, vi } from "vitest";
import XLSX from "xlsx";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    product: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    location: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    scrap: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    customer: { findMany: vi.fn(async () => []) },
    nfeEmitida: { findMany: vi.fn(async () => []) },
    nfeSequence: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
  },
}));

import {
  runVaaptPacote,
  type VaaptPacoteDeps,
} from "../../app/usecases/import/executors/vaapt-pacote.executor";
import { detectFile, detectAndValidate } from "../../app/usecases/import/import-detector";
import type {
  DetectedFile,
  ImportContext,
} from "../../app/usecases/import/import.types";
import { ImportValidationError } from "../../app/usecases/import/import.types";
import type { LinksExecDeps, LinkedProductRef } from "../../app/usecases/import/executors/product-links.executor";
import type { LocationExecDeps } from "../../app/usecases/import/executors/locations.executor";
import type { ScrapsExecDeps } from "../../app/usecases/import/executors/scraps.executor";
import type { CustomersExecDeps } from "../../app/usecases/import/executors/customers.executor";
import type { PhotosExecDeps } from "../../app/usecases/import/executors/product-photos.executor";
import type { NfeImportDeps } from "../../app/usecases/import/nfe-import.usecase";
import type { VaaptProdutosDeps } from "../../app/usecases/import/executors/vaapt-produtos.executor";
import type { ProductCreate } from "../../app/interfaces/product.interface";
import type { CustomerCreate } from "../../app/interfaces/customer.interface";
import type { NfeHistoricCreate } from "../../app/repositories/nfe.repository";

/* ------------------------------- Fixtures ------------------------------- */

function sheet(rows: unknown[][], filename: string, bookType: "xlsx" | "xls" = "xlsx"): DetectedFile {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Planilha1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType }) as Buffer;
  return detectFile({ fieldname: "file", filename, buffer });
}

const pecasFile = () =>
  sheet(
    [
      ["# Cod Peca", "MLB", "Nome peca", "Localizacao", "Cod Veiculo"],
      ["100", "MLB1", "PARACHOQUE", "Local 44 - Caixa 9", "36"],
      ["200", "MLB2", "FAROL", "LOCAL 1", null],
    ],
    "pecas.xlsx",
  );

const clientesFile = () =>
  sheet(
    [
      [
        "# Cod Cliente", "Nome Cliente", "CPF", "CNPJ", "Endereco", "Numero",
        "Complemento", "Bairro", "Cidade", "UF", "CEP", "Telefone", "Email",
        "RG", "IE", "TipoPessoa",
      ],
      ["1", "MARIA SILVA", "52998224725", "", "Rua A", "10", "", "Centro", "Itajai", "SC", "88300000", "4733334444", "m@x.com", "", "", "Fisica"],
    ],
    "clientes.xlsx",
  );

/**
 * Relatório de produtos (export NOVO). As colunas de veículo são o literal
 * "DUMMY" com um único código, como no arquivo real do cliente — é o que fazia
 * o detector classificá-lo como relatório de veículos.
 */
const produtosFile = () =>
  sheet(
    [
      [
        "Cod Peça", "Nome Produto", "Etiqueta", "Preço", "Cód Status",
        "Condição", "Qualidade", "Un Medida", "Qtd Inicial", "Qtd Disponivel",
        "Qtd Vendida", "Descrição Produto", "Localização Produto",
        "Categoria ML", "Mercado Livre", "Status Mercado Livre",
        "Config. Envio", "Placa Veículo", "Código Veículo", "Apelido Veículo",
        "Chassi", "RENAVAM", "Tipo Anúncio",
      ],
      [
        "1427772", "Porta Dianteira Gm Onix", "MLB1", 250,
        "Cadastro completo - estocado", "Usado", " ", "UN", 1, 1, 0,
        "Produto usado original", "S1 P1 N1 CX1", "MLB101763",
        "Produto anunciado", "active", "Frete Grátis", "DUMMY", "V76",
        "DUMMY", "DUMMY", "DUMMY", "gold_special",
      ],
      [
        "1427773", "Par De Bracinhos Do Capo", "MLB2", 100,
        "Cadastro completo - estocado", "Usado", " ", "UN", 1, 2, 0,
        "Produto usado original", "S1 P1 N1 CX2", "MLB101763",
        "Produto anunciado", "active", "Frete Grátis", "DUMMY", "V76",
        "DUMMY", "DUMMY", "DUMMY", "gold_special",
      ],
    ],
    "relatorio produtos parte 1.xlsx",
  );

const veiculosFile = () =>
  sheet(
    [
      ["# Codigo Veiculo", "Marca", "Modelo", "Chassi", "Placa", "Apelido", "Cor", "Ano modelo", "Valor da compra"],
      ["36", "VW", "GOL", "", "ABC1234", "", "PRATA", "2010", "5000"],
    ],
    "veiculos.xlsx",
  );

// Chave válida de 44 dígitos: CNPJ em [6,20) e SÉRIE em [22,25).
const CHAVE_33 = "42240112345678000195550010000000331000000001";

function nfeFile(): DetectedFile {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Relatório de Notas Fiscal Emitidas"],
      [],
      [
        "Cod Nota Fiscal", "N° NFe", "Status da NFe", "Motivo do cancelamento",
        "CFOP", "Nome do Cliente", "Data de Emissão", "Data de Autorização",
        "Valor Total da NFe", "Chave de Acesso",
      ],
      ["1", "33", "Autorizada", "", "5102", "MARIA", "01/02/2024", "01/02/2024", "150,00", CHAVE_33],
    ]),
    "Java Books",
  );
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xls" }) as Buffer;
  return detectFile({ fieldname: "file", filename: "notas.xls", buffer });
}

/* ---------------------------------- Deps -------------------------------- */

const product = (id: string, sku: string): LinkedProductRef => ({
  id,
  sku,
  skuNormalized: sku.trim().toLowerCase(),
  locationId: null,
  scrapId: null,
});

function makeDeps() {
  const attachCalls: Array<{ locationId: string; ids: string[] }> = [];
  const linkCalls: Array<{ scrapId: string; ids: string[] }> = [];
  const customersCreated: CustomerCreate[] = [];
  const scrapsCreated: Array<{ brand: string; model: string }> = [];
  const nfeCreated: NfeHistoricCreate[] = [];
  const locCreated: string[] = [];
  const fotosGravadas: Array<{ productId: string; urls: string[] }> = [];
  const produtosCriados: ProductCreate[] = [];
  let locSeq = 0;
  let scrapSeq = 0;

  const links: LinksExecDeps = {
    loadProductsBySkuNormalized: vi.fn(async (_u, norms: string[]) =>
      [product("p1", "100"), product("p2", "200")].filter(
        (p) => p.skuNormalized && norms.includes(p.skuNormalized),
      ),
    ),
    loadLocationCodes: vi.fn(async () => []),
    loadExistingScraps: vi.fn(async () => []),
    attachProducts: vi.fn(async (locationId: string, ids: string[]) => {
      attachCalls.push({ locationId, ids });
      return {
        attached: ids.map((id) => ({ id, sku: id, name: id })),
        alreadyAttached: [],
        skipped: [],
        location: { id: locationId, code: locationId, productsCount: ids.length, maxCapacity: 0 },
      };
    }) as LinksExecDeps["attachProducts"],
    linkScrapMany: vi.fn(async (scrapId: string, ids: string[]) => {
      linkCalls.push({ scrapId, ids });
      return { count: ids.length };
    }),
  };

  const locations: LocationExecDeps = {
    locationUseCase: {
      createLean: vi.fn(async (d: { code: string }) => {
        locCreated.push(d.code);
        return { id: `loc-${++locSeq}`, code: d.code };
      }) as never,
    },
    loadExistingCodes: vi.fn(async () => []),
  };

  const scraps: ScrapsExecDeps = {
    scrapUseCase: {
      create: vi.fn(async (d: { brand: string; model: string }) => {
        scrapsCreated.push({ brand: d.brand, model: d.model });
        return { id: `s-${++scrapSeq}` };
      }) as never,
    },
    loadExistingScraps: vi.fn(async () => []),
    loadLocationCodes: vi.fn(async () => []),
  };

  const customers: CustomersExecDeps = {
    customerUseCase: {
      create: vi.fn(async (d: CustomerCreate) => {
        customersCreated.push(d);
        return { id: `c-${customersCreated.length}` } as never;
      }),
    },
    loadExistingCustomers: vi.fn(async () => []),
  };

  const nfe: NfeImportDeps = {
    createHistoric: vi.fn(async (d: NfeHistoricCreate) => {
      nfeCreated.push(d);
      return { id: `nfe-${nfeCreated.length}` };
    }),
    loadExisting: vi.fn(async () => []),
    ajustarProximoNumero: vi.fn(async () => undefined),
  };

  const photos: PhotosExecDeps = {
    loadProductsBySkuNormalized: vi.fn(async (_u, norms: string[]) =>
      [
        { id: "p1", sku: "100", skuNormalized: "100", imageUrl: null, imageUrls: [] },
        { id: "p2", sku: "200", skuNormalized: "200", imageUrl: null, imageUrls: [] },
      ].filter((p) => norms.includes(p.skuNormalized)),
    ),
    setImageUrlsMany: vi.fn(
      async (items: Array<{ productId: string; imageUrls: string[] }>) => {
        for (const i of items) fotosGravadas.push({ productId: i.productId, urls: i.imageUrls });
        return { count: items.length };
      },
    ) as PhotosExecDeps["setImageUrlsMany"],
  };

  const produtos: VaaptProdutosDeps = {
    locations,
    makeProductUseCase: () => ({
      create: vi.fn(async (d: ProductCreate) => {
        produtosCriados.push(d);
        return { id: `np-${produtosCriados.length}` } as never;
      }),
    }),
    loadOwner: vi.fn(async () => ({ id: "admin-1" }) as never),
    loadProductsBySkuNormalized: vi.fn(async () => []),
    loadLegacyProducts: vi.fn(async () => []),
    contarProdutosDoTenant: vi.fn(async () => 0),
    attachProducts: links.attachProducts,
  };

  const deps: VaaptPacoteDeps = {
    links,
    locations,
    scraps,
    customers,
    nfe,
    photos,
    produtos,
    etiqueta: { loadTodosOsProdutos: async () => [] },
  };
  return { deps, attachCalls, linkCalls, customersCreated, scrapsCreated, nfeCreated, locCreated, fotosGravadas, produtosCriados };
}

const ctx = (dryRun: boolean, files: DetectedFile[]): ImportContext => ({
  targetUserId: "admin-1",
  files,
  dryRun,
});

/* --------------------------- Detector (pacote) --------------------------- */

describe("import/vaapt-pacote — detector", () => {
  it("aceita as 4 planilhas juntas numa só importação", () => {
    // detectAndValidate retorna { files, ignored } (contrato desde d578333,
    // "tolerar arquivos extras") — mesma desestruturação do import-detector.spec.
    const { files } = detectAndValidate("VAAPT", "PACOTE", [
      pecasFile(),
      clientesFile(),
      veiculosFile(),
      nfeFile(),
    ]);
    expect(files.map((f) => f.kind).sort()).toEqual([
      "VAAPT_CLIENTES",
      "VAAPT_NFE",
      "VAAPT_PECAS",
      "VAAPT_VEICULOS",
    ]);
  });

  it("aceita subconjunto parcial (só clientes)", () => {
    const { files } = detectAndValidate("VAAPT", "PACOTE", [clientesFile()]);
    expect(files.map((f) => f.kind)).toEqual(["VAAPT_CLIENTES"]);
  });

  it("dois arquivos do MESMO papel → erro de ambiguidade", () => {
    expect(() =>
      detectAndValidate("VAAPT", "PACOTE", [clientesFile(), clientesFile()]),
    ).toThrow(/apenas um de cada/i);
  });

  it("pacote SÓ com arquivo de OUTRO sistema → erro claro", () => {
    // Com a tolerância a extras, um arquivo estranho AO LADO de um válido é
    // apenas ignorado (ver import-detector.spec). O erro claro acontece quando
    // NENHUM arquivo Vaapt está presente — o slot obrigatório fica sem dono.
    const wdLocations = detectFile({
      fieldname: "file",
      filename: "locations.csv",
      buffer: Buffer.from(
        "Id,Initials,Description,HasStock,Level,ParentId,CompanyId,InitialsPath,MaxQuantity\n1,A,A,t,1,,251,A,10\n",
        "utf8",
      ),
    });
    expect(() =>
      detectAndValidate("VAAPT", "PACOTE", [wdLocations]),
    ).toThrow(ImportValidationError);
  });
});

/* ------------------------- Fotos dentro do pacote ------------------------ */

describe("import/vaapt-pacote — fase de fotos", () => {
  const fotosFile = () =>
    sheet(
      [
        ["# idPeca", "Titulo", "SKU", "Localização", "Codigo ML", "Link das imagens"],
        ["100", "PARACHOQUE", "EXCLUIDO", "CX 1", "MLB1", "https://s3/a.jpg"],
        ["100", "PARACHOQUE", "EXCLUIDO", "CX 1", "MLB1", "https://s3/b.jpg"],
        ["200", "FAROL", "EXCLUIDO", "CX 1", "MLB2", "https://s3/c.jpg"],
      ],
      "BackupImagesPecasEmp583.xlsx",
    );

  it("as 5 planilhas entram juntas no pacote", () => {
    const { files } = detectAndValidate("VAAPT", "PACOTE", [
      pecasFile(),
      clientesFile(),
      veiculosFile(),
      nfeFile(),
      fotosFile(),
    ]);
    expect(files.map((f) => f.kind).sort()).toEqual([
      "VAAPT_CLIENTES",
      "VAAPT_NFE",
      "VAAPT_PECAS",
      "VAAPT_PECAS_IMAGENS",
      "VAAPT_VEICULOS",
    ]);
  });

  it("APPLY grava as fotos na fase própria, agrupadas por peça", async () => {
    const d = makeDeps();
    const report = await runVaaptPacote(
      ctx(false, [pecasFile(), fotosFile()]),
      d.deps,
    );
    expect(Object.keys(report.porFase!)).toContain("fotos");
    expect(d.fotosGravadas).toHaveLength(2);
    expect(d.fotosGravadas.find((f) => f.productId === "p1")?.urls).toEqual([
      "https://s3/a.jpg",
      "https://s3/b.jpg",
    ]);
  });

  it("PRÉVIA do pacote não grava foto nenhuma", async () => {
    const d = makeDeps();
    await runVaaptPacote(ctx(true, [pecasFile(), fotosFile()]), d.deps);
    expect(d.fotosGravadas).toHaveLength(0);
  });

  it("pacote só com fotos roda (não exige as outras planilhas)", async () => {
    const d = makeDeps();
    const report = await runVaaptPacote(ctx(false, [fotosFile()]), d.deps);
    expect(Object.keys(report.porFase!)).toEqual(["fotos"]);
    expect(d.fotosGravadas).toHaveLength(2);
  });
});

/* ---------------------------- Runner (pacote) ---------------------------- */

describe("import/vaapt-pacote — runner (todas as fases numa execução)", () => {
  it("APPLY roda clientes → localizações → sucatas → vínculos → NF-e", async () => {
    const d = makeDeps();
    const report = await runVaaptPacote(
      ctx(false, [pecasFile(), clientesFile(), veiculosFile(), nfeFile()]),
      d.deps,
    );

    // Todas as 5 fases presentes, na ordem de dependência.
    expect(Object.keys(report.porFase ?? {})).toEqual([
      "clientes",
      "localizacoes",
      "sucatas",
      "vinculos",
      "nfe",
    ]);

    expect(d.customersCreated.map((c) => c.name)).toEqual(["MARIA SILVA"]);
    expect(d.locCreated.sort()).toEqual(["LOCAL1", "LOCAL44-CAIXA9"]);
    expect(d.scrapsCreated).toEqual([{ brand: "VW", model: "GOL" }]);
    expect(d.nfeCreated.map((n) => n.numero)).toEqual([33]);

    // O vínculo usa os ids criados na MESMA execução (localização e sucata).
    expect(d.attachCalls).toHaveLength(2);
    expect(d.linkCalls).toEqual([{ scrapId: "s-1", ids: ["p1"] }]);
    expect(report.contadores.produtos_casados).toBe(2);
    expect(report.contadores.erros ?? 0).toBe(0);
  });

  it("PRÉVIA (dryRun) não escreve em NENHUMA fase", async () => {
    const d = makeDeps();
    const report = await runVaaptPacote(
      ctx(true, [pecasFile(), clientesFile(), veiculosFile(), nfeFile()]),
      d.deps,
    );

    expect(d.customersCreated).toEqual([]);
    expect(d.locCreated).toEqual([]);
    expect(d.scrapsCreated).toEqual([]);
    expect(d.nfeCreated).toEqual([]);
    expect(d.attachCalls).toEqual([]);
    expect(d.linkCalls).toEqual([]);
    // Ainda assim a prévia projeta o que será feito.
    expect(report.porFase?.clientes.contadores.a_criar).toBe(1);
    expect(report.porFase?.localizacoes.contadores.a_criar).toBe(2);
    expect(report.porFase?.sucatas.contadores.a_criar).toBe(1);
    expect(report.porFase?.nfe.contadores.a_criar).toBe(1);
  });

  it("PARCIAL: só a planilha de clientes → roda clientes e pula o resto", async () => {
    const d = makeDeps();
    const report = await runVaaptPacote(ctx(false, [clientesFile()]), d.deps);
    expect(Object.keys(report.porFase ?? {})).toEqual(["clientes"]);
    expect(d.customersCreated).toHaveLength(1);
    expect(d.locCreated).toEqual([]);
    expect(d.nfeCreated).toEqual([]);
  });

  it("PARCIAL: peças sem veículos → localizações + vínculos, sem fase de sucatas", async () => {
    const d = makeDeps();
    const report = await runVaaptPacote(ctx(false, [pecasFile()]), d.deps);
    expect(Object.keys(report.porFase ?? {})).toEqual([
      "localizacoes",
      "vinculos",
    ]);
    expect(d.attachCalls).toHaveLength(2);
    // Sem veículos, a sucata do arquivo de peças não resolve (aviso, não erro).
    expect(d.linkCalls).toEqual([]);
    expect(report.porFase?.vinculos.contadores.sucata_nao_encontrada).toBe(1);
  });

  it("REGRESSÃO: relatório de produtos roda a fase de PRODUTOS, nunca a de sucatas", async () => {
    // Antes, este arquivo era classificado como "Vaapt — veículos" e o pacote
    // com UM arquivo era ACEITO EM SILÊNCIO: rodava a fase de sucatas em cima
    // de um relatório de produtos, criando lixo e dizendo "sucesso". As
    // colunas de veículo do export real são o literal "DUMMY".
    const d = makeDeps();
    const report = await runVaaptPacote(ctx(false, [produtosFile()]), d.deps);
    const fases = Object.keys(report.porFase ?? {});
    expect(fases).toContain("produtos");
    expect(fases).not.toContain("sucatas");
    expect(d.scrapsCreated).toEqual([]);
    // E os produtos entram de verdade, com nome e preço da planilha.
    expect(d.produtosCriados.map((p) => p.sku)).toEqual(["1427772", "1427773"]);
    expect(d.produtosCriados[0]).toMatchObject({
      name: "Porta Dianteira Gm Onix",
      price: 250,
      stock: 1,
    });
  });

  it("nenhuma planilha Vaapt reconhecida → erro claro", async () => {
    const d = makeDeps();
    await expect(runVaaptPacote(ctx(false, []), d.deps)).rejects.toThrow(
      /ao menos uma planilha do export Vaapt/i,
    );
  });

  it("idempotência: 2ª rodada não recria nada", async () => {
    const d = makeDeps();
    // Simula o estado pós-1ª rodada.
    d.deps.customers.loadExistingCustomers = vi.fn(async () => [
      { cpf: "52998224725", cnpj: null, name: "MARIA SILVA", phone: "4733334444", mobile: null, notes: null },
    ]);
    d.deps.locations.loadExistingCodes = vi.fn(async () => [
      { id: "loc-1", code: "LOCAL44-CAIXA9" },
      { id: "loc-2", code: "LOCAL1" },
    ]);
    d.deps.scraps.loadExistingScraps = vi.fn(async () => [
      { id: "s-36", notes: "Import Dexo · veículo #36", plate: "ABC1234", chassis: null },
    ]);
    d.deps.nfe.loadExisting = vi.fn(async () => [
      { serie: 1, numero: 33, chaveAcesso: CHAVE_33 },
    ]);

    const report = await runVaaptPacote(
      ctx(false, [pecasFile(), clientesFile(), veiculosFile(), nfeFile()]),
      d.deps,
    );

    expect(d.customersCreated).toEqual([]);
    expect(d.locCreated).toEqual([]);
    expect(d.scrapsCreated).toEqual([]);
    expect(d.nfeCreated).toEqual([]);
    expect(report.porFase?.clientes.contadores.ja_existiam_cpf).toBe(1);
    expect(report.porFase?.localizacoes.contadores.ja_existiam).toBe(2);
    expect(report.porFase?.sucatas.contadores.ja_existiam_marker).toBe(1);
    expect(report.porFase?.nfe.contadores.ja_existiam).toBe(1);
  });
});
