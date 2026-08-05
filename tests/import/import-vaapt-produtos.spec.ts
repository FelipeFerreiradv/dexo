/**
 * Relatório de produtos do Vaapt (export NOVO).
 *
 * REGRESSÃO DE UM BUG REAL: os dois arquivos que o cliente enviou eram
 * classificados como "Vaapt — veículos (sucatas)", porque a coluna de local é
 * "Localização Produto" (→ localizacaoproduto, que não casa com a assinatura
 * do arquivo-ponte) e a de veículo é "Código Veículo" (→ codigoveiculo, que
 * casa com a de veículos, junto de "Chassi" e "RENAVAM"). Disso saíam:
 *
 *   1 arquivo em VINCULOS → "Falta o arquivo obrigatório: Vaapt — peças/…"
 *   2 arquivos            → "Recebi 2 arquivos do tipo Vaapt — veículos…"
 *   1 arquivo em PACOTE   → ACEITO EM SILÊNCIO, rodando a fase de SUCATAS em
 *                           cima de um relatório de produtos.
 *
 * O 3º é o mais grave e é o que o teste `PACOTE com um arquivo` fixa.
 */

import { describe, it, expect, vi } from "vitest";
import XLSX from "xlsx";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    location: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    product: { findMany: vi.fn(async () => []) },
  },
}));

import { mapVaaptProdutos } from "../../app/usecases/import/mappers/vaapt-produtos.mapper";
import {
  runVaaptProdutos,
  type VaaptProdutosDeps,
} from "../../app/usecases/import/executors/vaapt-produtos.executor";
import { mapVaaptLinks } from "../../app/usecases/import/mappers/vinculos.mapper";
import { mapVaaptLocations } from "../../app/usecases/import/mappers/vaapt-localizacoes.mapper";
import {
  detectFile,
  detectAndValidate,
} from "../../app/usecases/import/import-detector";
import type {
  DetectedFile,
  ImportContext,
} from "../../app/usecases/import/import.types";
import type { ProductCreate } from "../../app/interfaces/product.interface";

/* ------------------------------- Fixtures ------------------------------- */

/** Cabeçalho REAL do export (medido nos arquivos do cliente). */
const H_PRODUTOS = [
  "Cod Peça", "Nome Produto", "Etiqueta", "Preço", "Cód Status", "Condição",
  "Qualidade", "Un Medida", "Qtd Inicial", "Qtd Disponivel", "Qtd Vendida",
  "Descrição Produto", "Localização Produto", "Categoria ML", "Mercado Livre",
  "Status Mercado Livre", "Config. Envio", "Placa Veículo", "Código Veículo",
  "Apelido Veículo", "Chassi", "RENAVAM", "Tipo Anúncio",
];

/**
 * Linha do export. Os campos de veículo são o literal "DUMMY" e o código é
 * um só para o arquivo inteiro — exatamente como no arquivo real.
 */
function linha(
  sku: string,
  nome: string,
  preco: number,
  qtd: number,
  local: string,
  status = "Cadastro completo - estocado",
  descricao = "Produto usado original",
): unknown[] {
  return [
    sku, nome, `MLB${sku}`, preco, status, "Usado",
    " ", "UN", 1, qtd, 0,
    descricao, local, "MLB101763", "Produto anunciado",
    "active", "Frete Grátis - Envio Padrão", "DUMMY", "V76",
    "DUMMY", "DUMMY", "DUMMY", "gold_special",
  ];
}

function sheet(rows: unknown[][], filename: string): DetectedFile {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Planilha1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return detectFile({ fieldname: "file", filename, buffer });
}

const produtosFile = (rows?: unknown[][], filename = "relatorio produtos parte 1.xlsx") =>
  sheet(
    [
      H_PRODUTOS,
      ...(rows ?? [
        linha("1427772", "Porta Dianteira Gm Onix", 250, 1, "S1 P1 N1 CX1"),
        linha("1427773", "Par De Bracinhos Do Capo", 100, 2, "S1 P1 N1 CX2"),
      ]),
    ],
    filename,
  );

/**
 * Formato DESLOCADO — o export real tem o TÍTULO na linha do cabeçalho e os
 * rótulos na 1ª linha de dados. É o caminho que a produção realmente usa.
 */
const produtosFileDeslocado = () =>
  sheet(
    [
      ["Relatório de Produtos Cadastrados - Parte 1", ...H_PRODUTOS.slice(1).map(() => null)],
      H_PRODUTOS,
      linha("1427772", "Porta Dianteira Gm Onix", 250, 1, "S1 P1 N1 CX1"),
      linha("1427773", "Par De Bracinhos Do Capo", 100, 2, "S1 P1 N1 CX2"),
    ],
    "relatorio produtos deslocado.xlsx",
  );

/** Arquivo-ponte CLÁSSICO — tem de continuar sendo VAAPT_PECAS. */
const pecasFile = () =>
  sheet(
    [
      ["# Cod Peca", "MLB", "Nome peca", "Localizacao", "Cod Veiculo"],
      ["100", "MLB1", "PARACHOQUE", "Local 44 - Caixa 9", "36"],
    ],
    "pecas.xlsx",
  );

/** Relatório de veículos clássico — tem de continuar sendo VAAPT_VEICULOS. */
const veiculosFile = () =>
  sheet(
    [
      ["# Codigo Veiculo", "Marca", "Modelo", "Chassi", "Placa", "Apelido", "Cor", "Ano modelo", "Valor da compra"],
      [1247, "VW", "GOL", "9BWZZZ373WT080199", "ABC1234", "Gol branco", "Branco", "2012", 5000],
    ],
    "Backup Veiculos - 412.xlsx",
  );

function makeDeps(
  existing: Array<{
    id: string;
    sku: string;
    skuNormalized: string | null;
    locationId: string | null;
  }> = [],
  /** Total que o cliente já tem no Dexo (guarda de catálogo duplicado). */
  produtosNoTenant = 0,
) {
  const created: ProductCreate[] = [];
  const attachCalls: Array<{ locationId: string; ids: string[] }> = [];
  const locCreated: string[] = [];
  const ownerCalls: string[] = [];
  let locSeq = 0;
  let legacyCalls = 0;
  let tenantCounts = 0;
  const deps: VaaptProdutosDeps = {
    locations: {
      locationUseCase: {
        createLean: vi.fn(async (d: { code: string }) => {
          locCreated.push(d.code);
          return { id: `loc-${++locSeq}`, code: d.code } as never;
        }),
      },
      loadExistingCodes: vi.fn(async () => []),
    },
    makeProductUseCase: () => ({
      create: vi.fn(async (data: ProductCreate) => {
        created.push(data);
        return { id: `p-${created.length}` } as never;
      }),
    }),
    loadOwner: vi.fn(async (userId: string) => {
      ownerCalls.push(userId);
      return { id: userId } as never;
    }),
    // Espelha o preload real: o `IN` casa só quem tem skuNormalized…
    loadProductsBySkuNormalized: vi.fn(async (_u, norms: string[]) =>
      existing.filter((e) => e.skuNormalized && norms.includes(e.skuNormalized)),
    ),
    // …e os legados (skuNormalized NULL), que o `IN` nunca pega, vêm à parte.
    loadLegacyProducts: vi.fn(async () => {
      legacyCalls++;
      return existing.filter((e) => e.skuNormalized === null);
    }),
    contarProdutosDoTenant: vi.fn(async () => {
      tenantCounts++;
      return produtosNoTenant;
    }),
    attachProducts: vi.fn(async (locationId: string, ids: string[]) => {
      attachCalls.push({ locationId, ids });
      return {
        attached: ids.map((id) => ({ id, sku: id, name: id })),
        alreadyAttached: [],
        skipped: [],
        location: { id: locationId, code: locationId, productsCount: ids.length, maxCapacity: 0 },
      };
    }) as VaaptProdutosDeps["attachProducts"],
  };
  return {
    deps,
    created,
    attachCalls,
    locCreated,
    ownerCalls,
    legadosCarregados: () => legacyCalls,
    contagensDoTenant: () => tenantCounts,
  };
}

const ctx = (dryRun: boolean, file: DetectedFile): ImportContext => ({
  targetUserId: "admin-1",
  files: [file],
  dryRun,
});

/* ------------------------------- Detector -------------------------------- */

describe("import/vaapt-produtos — detector", () => {
  it("o relatório de produtos vira VAAPT_PRODUTOS, não VAAPT_VEICULOS", () => {
    expect(produtosFile().kind).toBe("VAAPT_PRODUTOS");
  });

  it("também no formato DESLOCADO (título na linha do cabeçalho)", () => {
    const f = produtosFileDeslocado();
    expect(f.kind).toBe("VAAPT_PRODUTOS");
    // Os rótulos REAIS viraram o header, e a linha de rótulos saiu dos dados.
    expect(f.header).toContain("Localização Produto");
    expect(f.rows).toHaveLength(2);
  });

  it("ZERO REGRESSÃO: o arquivo-ponte clássico continua VAAPT_PECAS", () => {
    expect(pecasFile().kind).toBe("VAAPT_PECAS");
  });

  it("ZERO REGRESSÃO: o relatório de veículos continua VAAPT_VEICULOS", () => {
    expect(veiculosFile().kind).toBe("VAAPT_VEICULOS");
  });

  it("um arquivo em VINCULOS deixa de dar 'falta o arquivo obrigatório'", () => {
    const { files } = detectAndValidate("VAAPT", "VINCULOS", [produtosFile()]);
    expect(files.map((f) => f.kind)).toEqual(["VAAPT_PRODUTOS"]);
  });

  it("um arquivo na entidade PRODUTOS é aceito", () => {
    const { files, ignored } = detectAndValidate("VAAPT", "PRODUTOS", [produtosFile()]);
    expect(files.map((f) => f.kind)).toEqual(["VAAPT_PRODUTOS"]);
    expect(ignored).toEqual([]);
  });

  it("no PACOTE convive com as outras planilhas, cada uma no seu papel", () => {
    const { files } = detectAndValidate("VAAPT", "PACOTE", [
      produtosFile(),
      veiculosFile(),
    ]);
    expect(files.map((f) => f.kind).sort()).toEqual([
      "VAAPT_PRODUTOS",
      "VAAPT_VEICULOS",
    ]);
  });

  it("duas PARTES do mesmo relatório continuam sendo erro — e a mensagem NOMEIA os arquivos", () => {
    // Felipe optou por "uma parte por vez": a regra de papel repetido fica
    // intacta. O que muda é o diagnóstico.
    let msg = "";
    try {
      detectAndValidate("VAAPT", "PACOTE", [
        produtosFile(undefined, "parte 1.xlsx"),
        produtosFile(undefined, "parte 2.xlsx"),
      ]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/apenas um de cada/i);
    expect(msg).toContain("parte 1.xlsx");
    expect(msg).toContain("parte 2.xlsx");
    // As colunas lidas entram (truncadas em 12 pelo describeHeader) — é o que
    // permite ver a classificação sem pedir o arquivo ao cliente.
    expect(msg).toContain("Colunas lidas");
    expect(msg).toContain("Cod Peça");
  });

  it("quando falta o obrigatório, a mensagem diz o que CADA arquivo aceito virou", () => {
    // Um arquivo aceito com o papel errado não entra em `ignored` — sem esta
    // lista o operador não tem como descobrir a classificação.
    let msg = "";
    try {
      detectAndValidate("VAAPT", "SUCATAS", [pecasFile()]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Falta o arquivo obrigat/i);
  });
});

/* -------------------------------- Mapper --------------------------------- */

describe("import/vaapt-produtos — mapper", () => {
  it("lê SKU, nome, preço, estoque, descrição e localização", () => {
    const r = mapVaaptProdutos(produtosFile());
    expect(r.produtos).toHaveLength(2);
    expect(r.produtos[0]).toMatchObject({
      sku: "1427772",
      name: "Porta Dianteira Gm Onix",
      price: 250,
      stock: 1,
      description: "Produto usado original",
      locationCode: "S1P1N1CX1", // plano, convenção Vaapt
      locationText: "S1 P1 N1 CX1",
      etiqueta: "MLB1427772",
      mlCategoriaExterna: "MLB101763",
    });
  });

  it("ESTOQUE FANTASMA: peça 'Vendido' com Qtd Disponivel entra com estoque ZERO", () => {
    // Medido nos dois arquivos reais: 15.037 linhas "Vendido", das quais 10.782
    // trazem Qtd Disponivel > 0. Sem esta regra seriam 10.782 anúncios de peça
    // que já saiu do estoque.
    const r = mapVaaptProdutos(
      produtosFile([
        linha("1", "Vendida com qtd", 10, 1, "L1", "Vendido"),
        linha("2", "Disponivel", 10, 3, "L1", "Cadastro completo - estocado"),
      ]),
    );
    expect(r.produtos.map((p) => [p.sku, p.stock])).toEqual([
      ["1", 0],
      ["2", 3],
    ]);
    expect(r.estoqueZeradoPorStatus).toBe(1);
    // O cadastro entra igual — só a quantidade não.
    expect(r.produtos[0].name).toBe("Vendida com qtd");
    expect(r.produtos[0].price).toBe(10);
    expect(r.avisos.some((a) => /estoque ZERO/i.test(a.motivo))).toBe(true);
  });

  it("ESTOQUE FANTASMA: 'não estocado' também zera (com e sem acento)", () => {
    const r = mapVaaptProdutos(
      produtosFile([
        linha("1", "A", 10, 1, "L1", "Cadastro completo - não estocado"),
        linha("2", "B", 10, 1, "L1", "Cadastro parcial - nao estocado"),
        linha("3", "C", 10, 1, "L1", "Cadastro parcial - estocado"),
      ]),
    );
    expect(r.produtos.map((p) => p.stock)).toEqual([0, 0, 1]);
    expect(r.estoqueZeradoPorStatus).toBe(2);
  });

  it("'Condição' = Novo vira quality NOVO; o resto continua SEMINOVO", () => {
    const r = mapVaaptProdutos(
      produtosFile([
        [...linha("1", "Nova", 10, 1, "L1").slice(0, 5), "Novo", ...linha("1", "Nova", 10, 1, "L1").slice(6)],
        linha("2", "Usada", 10, 1, "L1"),
      ]),
    );
    expect(r.produtos.map((p) => p.quality)).toEqual(["NOVO", "SEMINOVO"]);
  });

  it("'Etiqueta' é a etiqueta física, não o MLB — e status/qtd vendida são preservados", () => {
    // 27.058 dos 28.880 valores reais sao numero puro. Guardar isso como "mlb"
    // faria 27.058 produtos mentirem para qualquer relatorio futuro.
    const r = mapVaaptProdutos(produtosFile());
    expect(r.produtos[0].etiqueta).toBe("MLB1427772");
    expect(r.produtos[0].status).toBe("Cadastro completo - estocado");
    expect(r.produtos[0].qtdVendida).toBe(0);
  });

  it("estoque vem de 'Qtd Disponivel', não de 'Qtd Inicial'", () => {
    // Qtd Inicial é 1 na fixture; Qtd Disponivel é 7.
    const r = mapVaaptProdutos(
      produtosFile([linha("900", "Farol", 80, 7, "LOCAL 1")]),
    );
    expect(r.produtos[0].stock).toBe(7);
  });

  it("localização plana: 'S1 P1 N1 CX1' → 'S1P1N1CX1' (paridade com migracao-vaapt.ts)", () => {
    const r = mapVaaptProdutos(produtosFile());
    expect(r.locationItems.map((l) => l.code)).toEqual(["S1P1N1CX1", "S1P1N1CX2"]);
    // Nó plano: sem pai, e a descrição preserva o texto original.
    expect(r.locationItems[0]).toMatchObject({
      code: "S1P1N1CX1",
      description: "S1 P1 N1 CX1",
      parentCode: null,
    });
  });

  it("'Cód Status' = Excluido pula a linha", () => {
    const r = mapVaaptProdutos(
      produtosFile([
        linha("1", "Vale", 10, 1, "L1"),
        linha("2", "Nao vale", 10, 1, "L1", "Excluido"),
        linha("3", "Vendida mas vale", 10, 0, "L1", "Vendido"),
      ]),
    );
    expect(r.produtos.map((p) => p.sku)).toEqual(["1", "3"]);
    expect(r.excluidos).toBe(1);
    expect(r.avisos.some((a) => /Excluido/.test(a.motivo))).toBe(true);
  });

  it("dedup intra-arquivo por SKU (1ª vence) e conta as linhas sem SKU", () => {
    const r = mapVaaptProdutos(
      produtosFile([
        linha("ABC", "Primeira", 10, 1, "L1"),
        linha("abc", "Segunda", 99, 9, "L2"),
        linha("", "Sem sku", 10, 1, "L1"),
      ]),
    );
    expect(r.produtos).toHaveLength(1);
    expect(r.produtos[0].name).toBe("Primeira");
    expect(r.duplicadosSku).toBe(1);
    expect(r.semSku).toBe(1);
  });

  it("linha sem localização entra, só sem local", () => {
    const r = mapVaaptProdutos(produtosFile([linha("7", "Sem local", 10, 1, "")]));
    expect(r.produtos).toHaveLength(1);
    expect(r.produtos[0].locationCode).toBeNull();
    expect(r.semLocalizacao).toBe(1);
    expect(r.locationItems).toEqual([]);
  });

  it("os mappers de vínculo e de localização também leem 'Localização Produto'", () => {
    // Sem o sinônimo, mapVaaptLinks devolvia locationCode NULL em TODAS as
    // linhas: a importação dizia sucesso e não vinculava nada.
    const f = produtosFile();
    const links = mapVaaptLinks(f);
    expect(links.items.filter((i) => i.locationCode)).toHaveLength(2);
    expect(links.items[0].locationCode).toBe("S1P1N1CX1");
    // E a coluna de VEÍCULO segue de fora de propósito ("DUMMY" no export).
    expect(links.items[0].scrapKey).toBeNull();

    const locs = mapVaaptLocations(f);
    expect(locs.items.map((l) => l.code)).toEqual(["S1P1N1CX1", "S1P1N1CX2"]);
  });

  it("ZERO REGRESSÃO: o arquivo-ponte clássico continua lido igual", () => {
    const links = mapVaaptLinks(pecasFile());
    expect(links.items[0]).toMatchObject({
      sku: "100",
      locationCode: "LOCAL44-CAIXA9",
      locationLabel: "Local 44 - Caixa 9",
      scrapKey: "36",
    });
  });
});

/* ------------------------------- Executor -------------------------------- */

describe("import/vaapt-produtos — executor", () => {
  it("PRÉVIA não escreve nada e prevê o que o apply fará", async () => {
    const { deps, created, attachCalls, locCreated } = makeDeps();
    const r = await runVaaptProdutos(ctx(true, produtosFile()), deps);
    expect(created).toEqual([]);
    expect(attachCalls).toEqual([]);
    expect(locCreated).toEqual([]);
    expect(r.porFase?.produtos.contadores.a_criar).toBe(2);
    expect(r.porFase?.localizacoes.contadores.localizacoes_distintas).toBe(2);
    // A prévia mostra amostra do que seria criado.
    expect(r.porFase?.produtos.amostra?.length).toBe(2);
  });

  it("APPLY cria as localizações e os produtos faltantes, já com o local", async () => {
    const { deps, created, locCreated } = makeDeps();
    const r = await runVaaptProdutos(ctx(false, produtosFile()), deps);
    expect(locCreated).toEqual(["S1P1N1CX1", "S1P1N1CX2"]);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      userId: "admin-1",
      sku: "1427772",
      name: "Porta Dianteira Gm Onix",
      price: 250,
      stock: 1,
      description: "Produto usado original",
      quality: "SEMINOVO",
      location: "S1 P1 N1 CX1",
    });
    expect(created[0].locationId).toBeTruthy();
    // Rastro da origem em attributes; NÃO cria anúncio nem resolve categoria.
    expect(created[0].attributes?.migration?.value_name).toBe("VAAPT");
    expect(created[0].attributes?.vaaptEtiqueta?.value_name).toBe("MLB1427772");
    expect(created[0].attributes?.vaaptStatus?.value_name).toBe("Cadastro completo - estocado");
    expect(r.contadores.produtos_criados).toBe(2);
  });

  it("EGRESS: a consulta dos legados roda UMA vez, não uma por lote de 500 SKUs", async () => {
    // 1.200 SKUs = 3 lotes de preload. O precedente do IBR faz esta consulta
    // (sem filtro de SKU) DENTRO do laço, devolvendo sempre o mesmo conjunto.
    const linhas = Array.from({ length: 1200 }, (_, i) =>
      linha(String(500000 + i), `Peca ${i}`, 10, 1, `L${i % 40}`),
    );
    const d = makeDeps();
    await runVaaptProdutos(ctx(false, produtosFile(linhas)), d.deps);
    expect(d.created).toHaveLength(1200);
    expect(d.deps.loadProductsBySkuNormalized).toHaveBeenCalledTimes(3);
    expect(d.legadosCarregados()).toBe(1);
  });

  it("o dono é resolvido UMA vez, não uma por produto criado", async () => {
    const { deps, ownerCalls, created } = makeDeps();
    await runVaaptProdutos(ctx(false, produtosFile()), deps);
    expect(created).toHaveLength(2);
    expect(ownerCalls).toEqual(["admin-1"]); // 1 chamada, não 2
  });

  it("produto que JÁ existe é vinculado, nunca recriado", async () => {
    const { deps, created, attachCalls } = makeDeps([
      { id: "p-exist", sku: "1427772", skuNormalized: "1427772", locationId: null },
    ]);
    const r = await runVaaptProdutos(ctx(false, produtosFile()), deps);
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].ids).toEqual(["p-exist"]);
    expect(created.map((c) => c.sku)).toEqual(["1427773"]); // só o faltante
    expect(r.contadores.produtos_vinculados).toBe(1);
  });

  it("IDEMPOTÊNCIA: 2ª rodada (tudo já existe no local certo) não cria nem re-vincula", async () => {
    const { deps, created, attachCalls } = makeDeps([
      { id: "p1", sku: "1427772", skuNormalized: "1427772", locationId: "loc-1" },
      { id: "p2", sku: "1427773", skuNormalized: "1427773", locationId: "loc-2" },
    ]);
    deps.locations.loadExistingCodes = vi.fn(async () => [
      { id: "loc-1", code: "S1P1N1CX1" },
      { id: "loc-2", code: "S1P1N1CX2" },
    ]);
    const r = await runVaaptProdutos(ctx(false, produtosFile()), deps);
    expect(created).toEqual([]);
    expect(attachCalls).toEqual([]);
    expect(r.porFase?.produtos.contadores.local_ja_correto).toBe(2);
    expect(r.contadores.produtos_criados).toBe(0);
  });

  it("ANTI-DUPLICAÇÃO: legado com skuNormalized NULL é casado, nunca recriado", async () => {
    const { deps, created, attachCalls } = makeDeps([
      { id: "p-legado", sku: "1427772", skuNormalized: null, locationId: null },
    ]);
    await runVaaptProdutos(ctx(false, produtosFile()), deps);
    expect(attachCalls[0].ids).toEqual(["p-legado"]);
    expect(created.map((c) => c.sku)).toEqual(["1427773"]);
  });

  it("SKU que casa 2 produtos é ambíguo: não vincula nem cria", async () => {
    const { deps, created, attachCalls } = makeDeps([
      { id: "a", sku: "1427772", skuNormalized: "1427772", locationId: null },
      { id: "b", sku: "1427772", skuNormalized: "1427772", locationId: null },
    ]);
    const r = await runVaaptProdutos(
      ctx(false, produtosFile([linha("1427772", "Porta", 250, 1, "S1 P1 N1 CX1")])),
      deps,
    );
    expect(created).toEqual([]);
    expect(attachCalls).toEqual([]);
    expect(r.porFase?.produtos.contadores.sku_ambiguo).toBe(1);
  });

  it("create que falha por 'já existe' (corrida) vira skip, não erro", async () => {
    const { deps } = makeDeps();
    deps.makeProductUseCase = () => ({
      create: vi.fn(async () => {
        throw new Error("Produto com esse sku já existe");
      }),
    });
    const r = await runVaaptProdutos(
      ctx(false, produtosFile([linha("1", "X", 10, 1, "L1")])),
      deps,
    );
    expect(r.porFase?.produtos.contadores.ja_existiam_corrida).toBe(1);
    expect(r.contadores.erros).toBe(0);
  });

  it("GUARDA: avisa quando o cliente já tem catálogo e NENHUM SKU casa", async () => {
    // Caso real do 777 AutoParts: 24.415 produtos vindos da importação de
    // anúncios, e `Cod Peça` casando com ZERO deles — mas 8.857 batendo por
    // nome E preço, ou seja, as mesmas peças com outra numeração.
    const linhas = Array.from({ length: 200 }, (_, i) =>
      linha(String(900000 + i), `Peca ${i}`, 10, 1, "L1"),
    );
    const { deps, created } = makeDeps([], 24415);
    const r = await runVaaptProdutos(ctx(true, produtosFile(linhas)), deps);
    expect(created).toEqual([]); // prévia não escreve
    const aviso = r.porFase?.produtos.avisos[0]?.motivo ?? "";
    expect(aviso).toMatch(/catálogo duplicado/i);
    expect(aviso).toContain("24.415");
    expect(aviso).toContain("24.615"); // total projetado
    expect(r.porFase?.produtos.contadores.produtos_ja_no_dexo).toBe(24415);
  });

  it("GUARDA: cliente NOVO (Dexo vazio) não recebe o aviso", async () => {
    const linhas = Array.from({ length: 200 }, (_, i) =>
      linha(String(900000 + i), `Peca ${i}`, 10, 1, "L1"),
    );
    const { deps } = makeDeps([], 0);
    const r = await runVaaptProdutos(ctx(true, produtosFile(linhas)), deps);
    const avisos = (r.porFase?.produtos.avisos ?? []).map((a) => a.motivo).join(" ");
    expect(avisos).not.toMatch(/catálogo duplicado/i);
  });

  it("GUARDA: se ALGUM SKU casa, não avisa (a numeração confere)", async () => {
    const linhas = Array.from({ length: 200 }, (_, i) =>
      linha(String(900000 + i), `Peca ${i}`, 10, 1, "L1"),
    );
    const { deps } = makeDeps(
      [{ id: "p1", sku: "900000", skuNormalized: "900000", locationId: null }],
      24415,
    );
    const r = await runVaaptProdutos(ctx(true, produtosFile(linhas)), deps);
    const avisos = (r.porFase?.produtos.avisos ?? []).map((a) => a.motivo).join(" ");
    expect(avisos).not.toMatch(/catálogo duplicado/i);
  });

  it("GUARDA: o `count` roda SÓ na prévia, nunca no apply", async () => {
    const { deps, contagensDoTenant } = makeDeps([], 24415);
    await runVaaptProdutos(ctx(false, produtosFile()), deps);
    expect(contagensDoTenant()).toBe(0);
  });

  it("sem descrição na planilha, não força o campo (cai no padrão do tenant)", async () => {
    const { deps, created } = makeDeps();
    await runVaaptProdutos(
      ctx(false, produtosFile([linha("1", "X", 10, 1, "L1", "Cadastro completo - estocado", "")])),
      deps,
    );
    expect(created[0].description).toBeUndefined();
  });
});
