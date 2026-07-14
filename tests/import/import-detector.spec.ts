import { describe, it, expect } from "vitest";
import XLSX from "xlsx";
import {
  detectFile,
  detectAndValidate,
} from "../../app/usecases/import/import-detector";
import { readCsvBuffer } from "../../app/usecases/import/parse/csv-reader";
import { readXlsxBuffer } from "../../app/usecases/import/parse/xlsx-reader";
import { ImportValidationError } from "../../app/usecases/import/import.types";

function csv(text: string, name = "arquivo.csv") {
  return { fieldname: "file", filename: name, buffer: Buffer.from(text, "utf8") };
}

function xlsxOf(aoa: unknown[][], name = "arquivo.xlsx") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Planilha1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return { fieldname: "file", filename: name, buffer };
}

describe("import/detector — detecção por ASSINATURA de colunas (nunca por nome)", () => {
  it("locations.csv do WebDesmonte → WD_LOCATIONS", () => {
    const f = csv(
      "Id,Initials,Description,HasStock,CreatedAt,UpdatedAt,Level,IdentifycationType,ParentId,CompanyId,InitialsOrdered,OldId,DescriptionPath,HierarchyPath,InitialsPath,DepthCm,HeightCm,VolumeM3,WidthCm,MaxQuantity,SortPosition\nabc,CAIXA 22,Caixa,t,2024,2024,4,BOX,def,251,,,,,GALPÃO > CAIXA 22,,,,,10,1\n",
      "qualquer-nome.csv",
    );
    expect(detectFile(f).kind).toBe("WD_LOCATIONS");
  });

  it("products.csv do WebDesmonte → WD_PRODUCTS (checado antes dos demais)", () => {
    const f = csv(
      "Id,Code,Description,LocationId,PurchaseWasteId,SaleValue,PackageWeightG\n1,SKU1,Peça,loc1,pw1,10,500\n",
    );
    expect(detectFile(f).kind).toBe("WD_PRODUCTS");
  });

  it("purchase_waste.csv → WD_PURCHASE_WASTE", () => {
    const f = csv(
      "Id,AccessKey,CertidaoBaixaVeiculo,Lot,NfeNumber,Brand,Model,LicensePlate,Chassis,Year,Color,PurchaseValue\n1,,,L1,,VW,GOL,ABC1234,9BWAG4124FT592152,2010,PRETO,1000\n",
    );
    expect(detectFile(f).kind).toBe("WD_PURCHASE_WASTE");
  });

  it("customers.csv (pacote Ribeiro) → WD_CUSTOMERS", () => {
    const f = csv(
      "Id,CompanyId,CreatedAt,UpdatedAt,Name,FantasyName,Type,Document,RgIe,Phone,CellPhone,Email\n1,260,,,MARIA,,F,52998224725,,,,\n",
    );
    expect(detectFile(f).kind).toBe("WD_CUSTOMERS");
  });

  it("planilha de peças Vaapt (xlsx) → VAAPT_PECAS", () => {
    const f = xlsxOf([
      ["# Cod Peca", "MLB", "Nome peca", "Preco", "Status", "Localizacao", "Cod Veiculo"],
      ["100", "MLB123", "PARACHOQUE", "150", "Estocado", "Local 44 - Caixa 9", "36"],
    ]);
    expect(detectFile(f).kind).toBe("VAAPT_PECAS");
  });

  it("clientes Vaapt (xlsx) → VAAPT_CLIENTES", () => {
    const f = xlsxOf([
      ["# Cod Cliente", "Nome Cliente", "CPF", "CNPJ", "TipoPessoa"],
      ["1", "MARIA", "52998224725", null, "PF"],
    ]);
    expect(detectFile(f).kind).toBe("VAAPT_CLIENTES");
  });

  it("veículos Vaapt (xlsx) → VAAPT_VEICULOS", () => {
    const f = xlsxOf([
      ["# Codigo Veiculo", "Marca", "Modelo", "Chassi", "Placa"],
      ["36", "VW", "GOL", "9BWAG4124FT592152", "ABC1234"],
    ]);
    expect(detectFile(f).kind).toBe("VAAPT_VEICULOS");
  });

  it("resumo de NF-e invoicy (rótulos DESLOCADOS) → VAAPT_NFE", () => {
    // R0 = título, R1 vazia, R2 = rótulos, R3+ = dados (formato real).
    const f = xlsxOf([
      ["Relatório de Notas Fiscal Emitidas"],
      [],
      [
        "Cod Nota Fiscal",
        "N° NFe",
        "Status da NFe",
        "CFOP",
        "Nome do Cliente",
        "Data de Emissão",
        "Valor Total da NFe",
        "Chave de Acesso",
      ],
      ["1", "33", "Autorizada", "5102", "MARIA", "31/05/2024", "150,00", ""],
    ]);
    const detected = detectFile(f);
    expect(detected.kind).toBe("VAAPT_NFE");
    // O getter deve ler pelos rótulos reais da linha deslocada.
    expect(detected.rows.length).toBe(1);
    expect(detected.get(detected.rows[0], "N° NFe")).toBe("33");
    expect(detected.get(detected.rows[0], "Status da NFe")).toBe("Autorizada");
  });

  it("estoque.csv do IBR tabular → IBR_ESTOQUE", () => {
    const f = csv(
      "ProductId,SKU,BarCode,Description,Brand,Model,Active,QuantidadeEstoque,EstoqueMinimo,CustoAtual,CustoReal,ValorVenda,Ncm,Cest,LocationId,LocalizacaoSiglas,LocalizacaoDescricao\n100,2492,,Farol,Ford,KA,t,3,0,0.01,15,160,8708,,,BARR. > CX 1,Barracao\n",
      "estoque.csv",
    );
    expect(detectFile(f).kind).toBe("IBR_ESTOQUE");
  });

  it("nfe_emitidas.csv do IBR tabular → IBR_NFE (não confunde com Vaapt NFE)", () => {
    const f = csv(
      "NotaFiscalId,NumeroNotaFiscal,Serie,ChaveDeAcesso,DataEmissao,NomeDestinatario,CustomerId,ValorTotal,Status,TipoNF\n53025,1413,1,4123061387108700011455001,2023,MARIA,127450,40,0,1\n",
      "nfe_emitidas.csv",
    );
    expect(detectFile(f).kind).toBe("IBR_NFE");
  });

  it("estoque.csv rejeitado se o operador escolheu WebDesmonte clássico", () => {
    const estoque = csv(
      "ProductId,SKU,QuantidadeEstoque,ValorVenda,LocalizacaoSiglas\n1,2492,3,160,BARR.\n",
      "estoque.csv",
    );
    expect(() =>
      detectAndValidate("WEBDESMONTE", "PACOTE", [estoque]),
    ).toThrow(ImportValidationError);
  });

  it("arquivo irreconhecível → erro claro (nunca chuta)", () => {
    const f = csv("foo,bar\n1,2\n");
    expect(() => detectAndValidate("VAAPT", "CLIENTES", [f])).toThrow(
      ImportValidationError,
    );
  });

  it("arquivo de outro papel (sem o obrigatório) → erro 'falta o obrigatório'", () => {
    const clientes = xlsxOf([
      ["# Cod Cliente", "Nome Cliente", "CPF"],
      ["1", "MARIA", "52998224725"],
    ]);
    // clientes não é aceito em LOCALIZACOES → é ignorado; o obrigatório
    // (VAAPT_PECAS) está ausente → erro claro pedindo o arquivo certo.
    expect(() =>
      detectAndValidate("VAAPT", "LOCALIZACOES", [clientes]),
    ).toThrow(/Falta o arquivo obrigatório/i);
  });

  it("TOLERÂNCIA: pacote IBR inteiro em IBR/ESTOQUE usa estoque.csv e ignora o resto", () => {
    const estoque = csv(
      "ProductId,SKU,QuantidadeEstoque,ValorVenda,LocalizacaoSiglas\n1,2492,3,160,BARR.\n",
      "estoque.csv",
    );
    const nfe = csv(
      "NotaFiscalId,NumeroNotaFiscal,Serie,ChaveDeAcesso,DataEmissao,NomeDestinatario,CustomerId,ValorTotal,Status,TipoNF\n1,1413,1,4123,2023,MARIA,1,40,0,1\n",
      "nfe_emitidas.csv",
    );
    const empresa = csv("Id,CompanyName,CNPJ\n260,RIBEIRO,138\n", "empresa.csv");
    const vendas = csv(
      "VendaId,VendaProdutoId,ProductId,SKU,Produto,Quantidade,ValorUnitario\n1,2,3,9,X,1,10\n",
      "vendas_produtos.csv",
    );
    const { files, ignored } = detectAndValidate("IBR", "ESTOQUE", [
      estoque,
      nfe,
      empresa,
      vendas,
    ]);
    // Só o estoque.csv é usado; os 3 outros são ignorados (não derrubam).
    expect(files.map((f) => f.kind)).toEqual(["IBR_ESTOQUE"]);
    expect(ignored.map((i) => i.filename).sort()).toEqual([
      "empresa.csv",
      "nfe_emitidas.csv",
      "vendas_produtos.csv",
    ]);
  });

  it("XML é recusado com mensagem de fase futura", () => {
    const f = csv('<?xml version="1.0"?><nfe/>', "nota.xml");
    expect(() => detectFile(f)).toThrow(/XML/);
  });

  it("dois arquivos do mesmo papel → erro de ambiguidade", () => {
    const a = csv(
      "Id,Initials,InitialsPath,ParentId,Level\n1,A,A,,1\n",
      "a.csv",
    );
    const b = csv(
      "Id,Initials,InitialsPath,ParentId,Level\n2,B,B,,1\n",
      "b.csv",
    );
    expect(() =>
      detectAndValidate("WEBDESMONTE", "LOCALIZACOES", [a, b]),
    ).toThrow(/apenas um/i);
  });

  it("VINCULOS do WebDesmonte exige products.csv E locations.csv", () => {
    const products = csv(
      "Id,Code,LocationId,PurchaseWasteId\n1,SKU1,loc1,pw1\n",
    );
    expect(() =>
      detectAndValidate("WEBDESMONTE", "VINCULOS", [products]),
    ).toThrow(/Falta o arquivo/i);
  });
});

describe("import/parse — preservação de zeros à esquerda", () => {
  it("CSV mantém tudo string (zeros preservados)", () => {
    const t = readCsvBuffer(
      Buffer.from("Code,Document\n007,01234567890\n", "utf8"),
    );
    expect(t.rows[0].Code).toBe("007");
    expect(t.rows[0].Document).toBe("01234567890");
  });
  it("CSV trata aspas, vírgula interna e BOM", () => {
    const t = readCsvBuffer(
      Buffer.from('﻿A,B\n"x, y","com ""aspas"""\n', "utf8"),
    );
    expect(t.header).toEqual(["A", "B"]);
    expect(t.rows[0].A).toBe("x, y");
    expect(t.rows[0].B).toBe('com "aspas"');
  });
  it("planilha NORMAL com coluna extra sem header NÃO vira formato deslocado", () => {
    // 2 colunas nomeadas + 1 célula extra na linha de dados (coluna sem
    // header) — a heurística antiga engoliria a 1ª linha de dados.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["# Cod Peca", "Localizacao"],
        ["100", "LOCAL 1", "sobra"],
        ["200", "LOCAL 2"],
      ]),
      "Planilha1",
    );
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const t = readXlsxBuffer(buffer);
    expect(t.shiftedLabels).toBe(false);
    expect(t.rows).toHaveLength(2);
    expect(t.get(t.rows[0], "# Cod Peca")).toBe("100");
  });

  it("XLSX com dimensão forjada (bomba de células) é rejeitado", () => {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["A", "B"], ["1", "2"]]);
    sheet["!ref"] = "A1:ZZ1048576"; // ~700M células declaradas
    XLSX.utils.book_append_sheet(wb, sheet, "Planilha1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(() => readXlsxBuffer(buffer)).toThrow(/células/);
  });

  it("XLSX com header normal usa getter tolerante a acento/caixa", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["# Cod Peca", "Localização"],
        ["100", "LOCAL 1"],
      ]),
      "Planilha1",
    );
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const t = readXlsxBuffer(buffer);
    expect(t.shiftedLabels).toBe(false);
    expect(t.get(t.rows[0], "# cod peca")).toBe("100");
    expect(t.get(t.rows[0], "Localizacao")).toBe("LOCAL 1");
  });
});
