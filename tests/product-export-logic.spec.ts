import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  EXCEL_CELL_MAX,
  buildExportWorkbook,
  exportRetryDelayMs,
  EXPORT_COLUMNS,
  EXTRA_COLUMNS,
  IMPORT_COLUMNS,
  clampCell,
  exportColumnWidths,
  exportRowFromProduct,
  formatCompatibility,
  formatExportDate,
  formatListing,
  joinWithinLimit,
  sortForExport,
  type ExportProduct,
} from "../app/produtos/lib/product-export.logic";

function produto(over: Partial<ExportProduct> = {}): ExportProduct {
  return {
    id: "prod-1",
    sku: "7167",
    name: "Farol dianteiro esquerdo Gol G5",
    description: "Peça original, sem trincas.",
    price: 249.9,
    costPrice: 120,
    markup: 108.25,
    stock: 2,
    reservedStock: 1,
    brand: "Volkswagen",
    model: "Gol",
    year: "2010",
    version: "1.0",
    category: "Iluminação",
    partNumber: "5U0941005",
    quality: "SEMINOVO",
    heightCm: 30,
    widthCm: 40,
    lengthCm: 50,
    weightKg: 2.5,
    imageUrl: "https://cdn/x/1.jpg",
    imageUrls: ["https://cdn/x/1.jpg", "https://cdn/x/2.jpg"],
    isSecurityItem: false,
    isTraceable: true,
    sourceVehicle: "Gol G5 prata",
    location: {
      path: "GALPÃO > PRATELEIRA 4 > NIVEL 2 > CAIXA G3",
      description: "Caixa do fundo",
      typedText: null,
    },
    mlCategory: { code: "MLB193771", path: "Acessórios > Faróis" },
    shopeeCategoryId: "101",
    magaluCategoryId: null,
    olxCategoryId: null,
    fbCategoryId: null,
    compatibilities: [
      { brand: "Volkswagen", model: "Gol", version: "1.0", yearFrom: 2008, yearTo: 2012 },
      { brand: "Volkswagen", model: "Voyage", version: null, yearFrom: 2009, yearTo: 2009 },
    ],
    compatibilityPositions: ["Dianteira", "Esquerda"],
    ficha: [
      { id: "COLOR", name: "Cor", value: "Preto" },
      { id: "LATCH_BOLT_TYPE", name: null, value: "X" },
    ],
    extraData: [{ key: "etiquetaOrigem", value: "E-1234" }],
    listings: [
      {
        platform: "MERCADO_LIVRE",
        accountName: "LOJA A",
        externalListingId: "MLB123",
        status: "active",
        permalink: "https://produto.mercadolivre.com.br/MLB-123",
      },
      {
        platform: "MERCADO_LIVRE",
        accountName: "LOJA B",
        externalListingId: null,
        status: "error",
        permalink: null,
      },
      {
        platform: "SHOPEE",
        accountName: "Loja",
        externalListingId: "999",
        status: "unlist",
        permalink: null,
      },
    ],
    scrap: "Gol prata (Volkswagen Gol 2010)",
    createdByName: "Fulana",
    originPlatform: "MERCADO_LIVRE",
    createdAt: "2026-09-25T17:33:00.000Z",
    updatedAt: "2026-09-25T23:10:00.000Z",
    ...over,
  };
}

describe("colunas", () => {
  it("as 17 colunas do modelo de importação vêm primeiro, na mesma ordem", () => {
    expect(EXPORT_COLUMNS.slice(0, IMPORT_COLUMNS.length)).toEqual([
      ...IMPORT_COLUMNS,
    ]);
    expect(IMPORT_COLUMNS).toEqual([
      "SKU", "Nome", "Descrição", "Preço", "Custo", "Estoque", "Marca",
      "Modelo", "Ano", "Categoria", "Part Number", "Qualidade", "Altura (cm)",
      "Largura (cm)", "Comprimento (cm)", "Peso (kg)", "URL Imagem",
    ]);
  });

  it("nomes de coluna únicos e a localização logo depois do modelo", () => {
    expect(new Set(EXPORT_COLUMNS).size).toBe(EXPORT_COLUMNS.length);
    expect(EXTRA_COLUMNS[0]).toBe("Localização");
  });

  it("a linha tem exatamente as colunas declaradas", () => {
    expect(Object.keys(exportRowFromProduct(produto())).sort()).toEqual(
      [...EXPORT_COLUMNS].sort(),
    );
  });

  it("largura definida para todas as colunas", () => {
    expect(exportColumnWidths()).toHaveLength(EXPORT_COLUMNS.length);
  });
});

describe("exportRowFromProduct — compatibilidade com a exportação antiga", () => {
  // Mapeamento que estava em import-export-products.tsx até 25/09/2026,
  // copiado literalmente. Recebia o produto da listagem (Decimal vira texto
  // no JSON do Prisma).
  const antigo = (p: any) => ({
    SKU: p.sku ?? "",
    Nome: p.name ?? "",
    Descrição: p.description ?? "",
    Preço: Number(p.price ?? 0),
    Custo: p.costPrice != null ? Number(p.costPrice) : "",
    Estoque: Number(p.stock ?? 0),
    Marca: p.brand ?? "",
    Modelo: p.model ?? "",
    Ano: p.year ?? "",
    Categoria: p.category ?? "",
    "Part Number": p.partNumber ?? "",
    Qualidade: p.quality ?? "",
    "Altura (cm)": p.heightCm != null ? Number(p.heightCm) : "",
    "Largura (cm)": p.widthCm != null ? Number(p.widthCm) : "",
    "Comprimento (cm)": p.lengthCm != null ? Number(p.lengthCm) : "",
    "Peso (kg)": p.weightKg != null ? Number(p.weightKg) : "",
    "URL Imagem": p.imageUrl ?? "",
  });

  const soModelo = (row: Record<string, unknown>) =>
    Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, row[c]]));

  it("produto completo: mesmos valores nas 17 colunas", () => {
    const p = produto();
    const listagem = { ...p, price: "249.90", costPrice: "120.00", weightKg: "2.50" };
    expect(soModelo(exportRowFromProduct(p))).toEqual(antigo(listagem));
  });

  it("produto com campos vazios: mesmos valores nas 17 colunas", () => {
    const p = produto({
      description: null, costPrice: null, brand: null, model: null,
      year: null, category: null, partNumber: null, quality: null,
      heightCm: null, widthCm: null, lengthCm: null, weightKg: null,
      imageUrl: null, price: null,
    });
    expect(soModelo(exportRowFromProduct(p))).toEqual(antigo(p));
  });

  it("estoque zero e preço zero continuam números", () => {
    const row = exportRowFromProduct(produto({ stock: 0, price: 0 }));
    expect(row.Estoque).toBe(0);
    expect(row.Preço).toBe(0);
  });
});

describe("exportRowFromProduct — informações completas", () => {
  it("localização, descrição e texto digitado", () => {
    const row = exportRowFromProduct(
      produto({
        location: { path: "CX277", description: null, typedText: "Galpão velho" },
      }),
    );
    expect(row.Localização).toBe("CX277");
    expect(row["Descrição da localização"]).toBe("");
    expect(row["Localização (texto digitado)"]).toBe("Galpão velho");
    const semLocal = exportRowFromProduct(
      produto({ location: { path: null, description: null, typedText: null } }),
    );
    expect(semLocal.Localização).toBe("");
  });

  it("estoque reservado e disponível (nunca negativo)", () => {
    const row = exportRowFromProduct(produto({ stock: 2, reservedStock: 1 }));
    expect(row["Estoque reservado"]).toBe(1);
    expect(row["Estoque disponível"]).toBe(1);
    const inconsistente = exportRowFromProduct(produto({ stock: 0, reservedStock: 3 }));
    expect(inconsistente["Estoque disponível"]).toBe(0);
  });

  it("compatibilidades, posição e contagem", () => {
    const row = exportRowFromProduct(produto());
    expect(row.Compatibilidades).toBe(
      "Volkswagen Gol 1.0 (2008 a 2012); Volkswagen Voyage (2009)",
    );
    expect(row["Qtd. de veículos compatíveis"]).toBe(2);
    expect(row["Posição da peça"]).toBe("Dianteira, Esquerda");
  });

  it("ficha técnica usa o nome do campo e cai no id quando não há nome", () => {
    expect(exportRowFromProduct(produto())["Ficha técnica"]).toBe(
      "Cor: Preto; LATCH_BOLT_TYPE: X",
    );
    expect(exportRowFromProduct(produto())["Dados importados de outro sistema"]).toBe(
      "etiquetaOrigem: E-1234",
    );
  });

  it("imagens sem repetir a principal", () => {
    const row = exportRowFromProduct(produto());
    expect(row["Todas as imagens"]).toBe("https://cdn/x/1.jpg | https://cdn/x/2.jpg");
    expect(row["Qtd. de imagens"]).toBe(2);
  });

  it("anúncios por plataforma, com conta, id e status em português", () => {
    const row = exportRowFromProduct(produto());
    expect(row["Anúncios Mercado Livre"]).toBe(
      "LOJA A: MLB123 (Ativo); LOJA B: sem anúncio publicado (Erro)",
    );
    expect(row["Anúncios Shopee"]).toBe("Loja: 999 (Pausado)");
    expect(row["Anúncios Magalu"]).toBe("");
    expect(row["Links dos anúncios"]).toBe(
      "https://produto.mercadolivre.com.br/MLB-123",
    );
  });

  it("categorias, sucata, origem, autor, datas e id", () => {
    const row = exportRowFromProduct(produto());
    expect(row["Categoria Mercado Livre"]).toBe("Acessórios > Faróis");
    expect(row["Código da categoria Mercado Livre"]).toBe("MLB193771");
    expect(row["Código da categoria Shopee"]).toBe("101");
    expect(row["Sucata de origem"]).toBe("Gol prata (Volkswagen Gol 2010)");
    expect(row["Plataforma de origem"]).toBe("Mercado Livre");
    expect(row["Cadastrado por"]).toBe("Fulana");
    expect(row["Criado em"]).toBe("25/09/2026 14:33");
    expect(row["Atualizado em"]).toBe("25/09/2026 20:10");
    expect(row["ID do produto"]).toBe("prod-1");
    expect(row["Peça de segurança"]).toBe("Não");
    expect(row.Rastreável).toBe("Sim");
    expect(row["Markup (%)"]).toBe(108.25);
  });

  it("nenhuma célula passa do limite do Excel", () => {
    const enorme = "x".repeat(EXCEL_CELL_MAX + 500);
    const muitos = Array.from({ length: 3000 }, (_, i) => ({
      brand: "Chevrolet",
      model: `Modelo ${i}`,
      version: "1.4 LT flex manual",
      yearFrom: 2000,
      yearTo: 2020,
    }));
    const row = exportRowFromProduct(
      produto({ description: enorme, compatibilities: muitos }),
    );
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        expect(value.length).toBeLessThanOrEqual(EXCEL_CELL_MAX);
      }
    }
    expect(String(row.Descrição).endsWith("(texto cortado: limite do Excel)")).toBe(true);
    expect(String(row.Compatibilidades)).toMatch(
      /… e mais \d+ veículo\(s\) — lista completa no sistema$/,
    );
    expect(row["Qtd. de veículos compatíveis"]).toBe(3000);
  });
});

describe("formatadores", () => {
  it("formatCompatibility cobre ano único, faixa e ausências", () => {
    const base = { brand: "Fiat", model: "Palio", version: null };
    expect(formatCompatibility({ ...base, yearFrom: 2001, yearTo: 2005 })).toBe(
      "Fiat Palio (2001 a 2005)",
    );
    expect(formatCompatibility({ ...base, yearFrom: 2001, yearTo: null })).toBe(
      "Fiat Palio (a partir de 2001)",
    );
    expect(formatCompatibility({ ...base, yearFrom: null, yearTo: 2005 })).toBe(
      "Fiat Palio (até 2005)",
    );
    expect(formatCompatibility({ ...base, yearFrom: null, yearTo: null })).toBe(
      "Fiat Palio",
    );
  });

  it("formatListing traduz status e trata conta sem nome", () => {
    expect(
      formatListing({
        platform: "SHOPEE",
        accountName: null,
        externalListingId: "1",
        status: "seller_deleted",
        permalink: null,
      }),
    ).toBe("Conta: 1 (Excluído)");
  });

  it("formatExportDate usa o horário de Brasília e ignora lixo", () => {
    expect(formatExportDate("2026-01-01T02:59:00.000Z")).toBe("31/12/2025 23:59");
    expect(formatExportDate(null)).toBe("");
    expect(formatExportDate("não é data")).toBe("");
  });

  it("clampCell e joinWithinLimit respeitam o limite", () => {
    expect(clampCell("abc")).toBe("abc");
    expect(clampCell("y".repeat(EXCEL_CELL_MAX + 1)).length).toBe(EXCEL_CELL_MAX);
    const itens = ["aaaa", "bbbb", "cccc", "dddd"];
    expect(joinWithinLimit(itens, "; ", (n) => `+${n}`, 100)).toBe(
      "aaaa; bbbb; cccc; dddd",
    );
    const cortado = joinWithinLimit(itens, "; ", (n) => `+${n}`, 14);
    expect(cortado.length).toBeLessThanOrEqual(14);
    expect(cortado).toBe("aaaa; bbbb; +2");
    expect(joinWithinLimit(["x".repeat(50)], "; ", (n) => `+${n}`, 10)).toBe("+1");
  });
});

describe("exportRetryDelayMs", () => {
  it("tenta de novo só em 429, 5xx e falha de rede, no máximo 3 vezes", () => {
    expect(exportRetryDelayMs(429, 0)).toBe(1000);
    expect(exportRetryDelayMs(503, 1)).toBe(3000);
    expect(exportRetryDelayMs(null, 2)).toBe(8000);
    expect(exportRetryDelayMs(500, 3)).toBeNull();
    for (const definitivo of [200, 400, 401, 403, 404]) {
      expect(exportRetryDelayMs(definitivo, 0)).toBeNull();
    }
  });
});

/** Método de compressão de cada arquivo dentro do zip (0 = guardado, 8 = deflate). */
function zipEntries(buf: ArrayBuffer): Map<string, number> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const out = new Map<string, number>();
  for (let i = 0; i + 30 < bytes.length; i++) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const method = view.getUint16(i + 8, true);
    const nameLen = view.getUint16(i + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen));
    out.set(name, method);
  }
  return out;
}

describe("buildExportWorkbook", () => {
  it("sempre grava com compressão (sem ela a aba estoura a memória em base grande)", () => {
    const opts: Record<string, unknown>[] = [];
    const fake = {
      utils: {
        aoa_to_sheet: () => ({ "!ref": "A1:B2" }) as Record<string, unknown>,
        book_new: () => ({}),
        book_append_sheet: () => {},
      },
      write: (_wb: unknown, o: Record<string, unknown>) => {
        opts.push(o);
        return new ArrayBuffer(0);
      },
    };
    buildExportWorkbook(fake, [produto()]);
    expect(opts).toEqual([{ bookType: "xlsx", type: "array", compression: true }]);
  });

  it("arquivo real: compactado, cabeçalho completo, ordem da listagem e valores relidos", () => {
    const buf = buildExportWorkbook(XLSX as never, [
      produto({ id: "velho", sku: "001", stock: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
      produto({ id: "novo", sku: "002", stock: 1, createdAt: "2026-09-01T00:00:00.000Z" }),
      produto({ id: "zerado", sku: "003", stock: 0, createdAt: "2026-09-20T00:00:00.000Z" }),
    ]);
    expect(zipEntries(buf).get("xl/worksheets/sheet1.xml")).toBe(8);

    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    expect(wb.SheetNames).toEqual(["Produtos"]);
    const ws = wb.Sheets.Produtos;
    const header = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0];
    expect(header).toEqual([...EXPORT_COLUMNS]);
    expect(ws["!autofilter"]).toBeTruthy();

    const linhas = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
    expect(linhas.map((l) => l.SKU)).toEqual(["002", "001", "003"]);
    expect(linhas[0].Preço).toBe(249.9);
    expect(linhas[0].Localização).toBe("GALPÃO > PRATELEIRA 4 > NIVEL 2 > CAIXA G3");
    expect(linhas[0]["Anúncios Mercado Livre"]).toBe(
      "LOJA A: MLB123 (Ativo); LOJA B: sem anúncio publicado (Erro)",
    );
    expect(linhas[2].Estoque).toBe(0);
  });

  it("texto começando com = + - @ fica texto, não vira fórmula", () => {
    const buf = buildExportWorkbook(XLSX as never, [
      produto({ name: "=HYPERLINK(\"http://x\")", description: "+55 -1 @a" }),
    ]);
    const ws = XLSX.read(new Uint8Array(buf), { type: "array", cellFormula: true }).Sheets.Produtos;
    const nome = ws["B2"];
    expect(nome.v).toBe("=HYPERLINK(\"http://x\")");
    expect(nome.f).toBeUndefined();
    expect(ws["C2"].f).toBeUndefined();
  });
});

describe("sortForExport", () => {
  it("em estoque primeiro, mais novo primeiro, desempate estável por id", () => {
    const ordem = sortForExport([
      produto({ id: "a", stock: 0, createdAt: "2026-09-25T10:00:00.000Z" }),
      produto({ id: "b", stock: 1, createdAt: "2026-09-20T10:00:00.000Z" }),
      produto({ id: "c", stock: 1, createdAt: "2026-09-25T10:00:00.000Z" }),
      produto({ id: "d", stock: 1, createdAt: "2026-09-25T10:00:00.000Z" }),
    ]).map((p) => p.id);
    expect(ordem).toEqual(["d", "c", "b", "a"]);
  });

  it("não altera o array recebido", () => {
    const lista = [produto({ id: "a", stock: 0 }), produto({ id: "b", stock: 1 })];
    sortForExport(lista);
    expect(lista.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
