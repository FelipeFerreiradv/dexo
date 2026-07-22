/**
 * Regressão do bug reportado: o export "Veiculos<N>.xlsx" do Vaapt (uma linha
 * por FOTO do veículo, SEM Marca/Modelo) caía em DESCONHECIDO porque a
 * assinatura exigia "Marca" e "Modelo". Em SUCATAS isso virava
 * "Falta o arquivo obrigatório"; em PACOTE o arquivo era descartado em
 * silêncio e as sucatas simplesmente não entravam.
 */

import { describe, it, expect } from "vitest";
import XLSX from "xlsx";
import {
  detectFile,
  detectAndValidate,
} from "../../app/usecases/import/import-detector";
import { mapVaaptScraps } from "../../app/usecases/import/mappers/sucatas.mapper";
import { ImportValidationError } from "../../app/usecases/import/import.types";

function xlsx(aoa: unknown[][], filename: string) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Planilha1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return { fieldname: "file", filename, buffer };
}

/* Cabeçalhos REAIS (medidos nos arquivos que o Felipe anexou). */
const H_VEICULOS_FOTOS = [
  "# Codigo Veiculo",
  "Placa",
  "numero motor",
  "Numero chassi",
  "Renavam",
  "valor_compra",
  "data_compra",
  "Link da Imagem",
  "Nome da Imagem",
];
const H_VEICULOS_CLASSICO = [
  "# Codigo Veiculo",
  "Marca",
  "Modelo",
  "Chassi",
  "Placa",
  "Apelido",
  "Cor",
  "Ano modelo",
  "Valor da compra",
];
const H_PECAS = [
  "# Cod Peca",
  "MLB",
  "Nome peca",
  "Localizacao",
  "Cod Veiculo",
];
const H_PECAS_IMAGENS = [
  "# idPeca",
  "Titulo",
  "SKU",
  "Preço",
  "intStatus",
  "Localização",
  "Quantidade inicial",
  "Quantidade disponivel",
  "Quantidade vendida",
  "Codigo ML",
  "strCodigoVeiculo",
  "Link das imagens",
];

const CHASSI = "9BWZZZ373WT080199";

const veiculosFotos = (rows: unknown[][] = []) =>
  xlsx(
    [
      H_VEICULOS_FOTOS,
      ...(rows.length
        ? rows
        : [
            [1247, "CMK8301", "AFZ298390", CHASSI, 700153780, 5000, 45140, "https://x/1.jpg", "Local chassi"],
          ]),
    ],
    "Veiculos583.xlsx",
  );

describe("detector — variante do relatório de veículos SEM Marca/Modelo", () => {
  it("Veiculos<N>.xlsx (uma linha por foto) → VAAPT_VEICULOS", () => {
    expect(detectFile(veiculosFotos()).kind).toBe("VAAPT_VEICULOS");
  });

  it("a variante clássica (com Marca/Modelo) continua VAAPT_VEICULOS", () => {
    const f = xlsx(
      [H_VEICULOS_CLASSICO, ["36", "VW", "GOL", CHASSI, "ABC1234", null, null, "2010", "1000"]],
      "Backup Veiculos - 583.xlsx",
    );
    expect(detectFile(f).kind).toBe("VAAPT_VEICULOS");
  });

  it("a planilha de peças NÃO é roubada pela assinatura afrouxada", () => {
    // "Cod Veiculo" normaliza para codveiculo ≠ codigoveiculo.
    const f = xlsx([H_PECAS, ["100", "MLB1", "PARACHOQUE", "CX PR 1", "36"]], "BackupPecas583.xlsx");
    expect(detectFile(f).kind).toBe("VAAPT_PECAS");
  });

  it("só a coluna do código, sem nenhum atributo de veículo → DESCONHECIDO", () => {
    // anyOfMin=2 impede que um arquivo qualquer com essa coluna vire sucata.
    const f = xlsx([["# Codigo Veiculo", "Observacao"], ["1", "nada"]], "x.xlsx");
    expect(detectFile(f).kind).toBe("DESCONHECIDO");
  });

  it("o export de fotos das peças vira VAAPT_PECAS_IMAGENS (não DESCONHECIDO)", () => {
    const f = xlsx(
      [H_PECAS_IMAGENS, [2808524, "LANTERNA", "EXCLUIDO", "124.00", "Vendido", "CX PR 1", 1000, 1000, "0.000", "MLB1", "V76", "https://s3/a.jpg"]],
      "BackupImagesPecasEmp583.xlsx",
    );
    expect(detectFile(f).kind).toBe("VAAPT_PECAS_IMAGENS");
  });

  it("arquivo não reconhecido reporta as COLUNAS lidas (diagnóstico)", () => {
    const f = xlsx([["Coluna A", "Coluna B", "Coluna C"], [1, 2, 3]], "misterio.xlsx");
    const pecas = xlsx([H_PECAS, ["100", "MLB1", "P", "CX", null]], "pecas.xlsx");
    const res = detectAndValidate("VAAPT", "PACOTE", [pecas, f]);
    const ign = res.ignored.find((i) => i.filename === "misterio.xlsx");
    expect(ign?.motivo).toContain("Coluna A");
    expect(ign?.motivo).toContain("Coluna B");
  });
});

describe("detector — cenário exato reportado pelo operador", () => {
  it("SUCATAS com o Veiculos583.xlsx deixa de dar 'Falta o arquivo obrigatório'", () => {
    const res = detectAndValidate("VAAPT", "SUCATAS", [veiculosFotos()]);
    expect(res.files.map((f) => f.kind)).toEqual(["VAAPT_VEICULOS"]);
    expect(res.ignored).toHaveLength(0);
  });

  it("PACOTE com os 3 arquivos: peças + veículos entram, fotos são ignoradas COM motivo", () => {
    const pecas = xlsx([H_PECAS, ["100", "MLB1", "PARACHOQUE", "CX PR 1", "36"]], "BackupPecas583.xlsx");
    const imagens = xlsx(
      [H_PECAS_IMAGENS, [2808524, "LANTERNA", "EXCLUIDO", "124.00", "Vendido", "CX PR 1", 1000, 1000, "0.000", "MLB1", "V76", "https://s3/a.jpg"]],
      "BackupImagesPecasEmp583.xlsx",
    );
    const res = detectAndValidate("VAAPT", "PACOTE", [pecas, veiculosFotos(), imagens]);

    expect(res.files.map((f) => f.kind).sort()).toEqual([
      "VAAPT_PECAS",
      "VAAPT_VEICULOS",
    ]);
    expect(res.ignored).toHaveLength(1);
    expect(res.ignored[0].filename).toBe("BackupImagesPecasEmp583.xlsx");
    expect(res.ignored[0].motivo).toContain("fotos das peças");
  });

  it("dois arquivos do MESMO papel continuam sendo erro (ambiguidade)", () => {
    expect(() =>
      detectAndValidate("VAAPT", "SUCATAS", [veiculosFotos(), veiculosFotos()]),
    ).toThrow(ImportValidationError);
  });
});

describe("mapper de sucatas — variante com uma linha por foto", () => {
  const tresFotosDoMesmoVeiculo = () =>
    veiculosFotos([
      [1247, "CMK8301", "AFZ298390", CHASSI, 700153780, 5000, 45140, "https://x/1.jpg", "Local chassi"],
      [1247, "CMK8301", "AFZ298390", CHASSI, 700153780, 5000, 45140, "https://x/2.jpg", "Frente"],
      [1247, "CMK8301", "AFZ298390", CHASSI, 700153780, 5000, 45140, "https://x/3.jpg", "Motor"],
      [1248, "XYZ9876", "M999", null, null, 3000, null, "https://x/4.jpg", "Lateral"],
    ]);

  it("mapeia os campos pelos rótulos da variante nova", () => {
    const r = mapVaaptScraps(detectFile(tresFotosDoMesmoVeiculo()));
    const v = r.items[0];
    expect(v.cod).toBe("1247");
    expect(v.plate).toBe("CMK8301");
    expect(v.chassis).toBe(CHASSI); // veio de "Numero chassi"
    expect(v.cost).toBe(5000); // veio de "valor_compra"
    expect(v.renavam).toBe("700153780");
    expect(v.engineNumber).toBe("AFZ298390"); // veio de "numero motor"
    expect(v.entryDate).toBeInstanceOf(Date); // "data_compra" serial do Excel
    expect(v.notes).toContain("veículo #1247");
  });

  it("as linhas repetidas viram UM veículo e contam como repetidas, não inválidas", () => {
    const r = mapVaaptScraps(detectFile(tresFotosDoMesmoVeiculo()));
    expect(r.items).toHaveLength(2); // 1247 e 1248
    expect(r.totalRows).toBe(4);
    expect(r.duplicateRows).toBe(2); // as 2 fotos extras do 1247
    expect(r.invalidRows).toBe(0);
  });

  it("sem colunas Marca/Modelo: INDEFINIDO + UM aviso para o arquivo todo", () => {
    const r = mapVaaptScraps(detectFile(tresFotosDoMesmoVeiculo()));
    expect(r.items.every((i) => i.brand === "INDEFINIDO")).toBe(true);
    expect(r.items.every((i) => i.model === "INDEFINIDO")).toBe(true);
    const avisosMarca = r.avisos.filter((a) => a.motivo.includes("Marca"));
    expect(avisosMarca).toHaveLength(1);
    expect(avisosMarca[0].linha).toBeUndefined(); // é do arquivo, não de uma linha
  });

  it("a variante clássica mapeia exatamente como antes (zero regressão)", () => {
    const f = xlsx(
      [
        H_VEICULOS_CLASSICO,
        ["36", "VW", "GOL", CHASSI, "abc-1234", "Golzinho", "PRETO", "2010", "1.500,00"],
      ],
      "Backup Veiculos - 583.xlsx",
    );
    const r = mapVaaptScraps(detectFile(f));
    const v = r.items[0];
    expect(v.brand).toBe("VW");
    expect(v.model).toBe("GOL");
    expect(v.chassis).toBe(CHASSI);
    expect(v.plate).toBe("ABC1234");
    expect(v.cost).toBe(1500);
    expect(v.year).toBe("2010");
    expect(v.version).toBe("Golzinho");
    expect(v.color).toBe("PRETO");
    // Colunas que só existem na variante nova ficam nulas.
    expect(v.renavam).toBeNull();
    expect(v.engineNumber).toBeNull();
    expect(v.entryDate).toBeNull();
    expect(r.duplicateRows).toBe(0);
    expect(r.avisos.filter((a) => a.motivo.includes("Marca"))).toHaveLength(0);
  });
});

describe("mapper de sucatas — avisos de coluna ausente", () => {
  it("basta UMA das colunas faltar (Marca presente, Modelo ausente)", () => {
    const f = xlsx(
      [
        ["# Codigo Veiculo", "Marca", "Placa", "Chassi"],
        ["1", "VW", "ABC1234", CHASSI],
      ],
      "v.xlsx",
    );
    const r = mapVaaptScraps(detectFile(f));
    expect(r.items[0].brand).toBe("VW");
    expect(r.items[0].model).toBe("INDEFINIDO");
    const aviso = r.avisos.find((a) => a.motivo.includes("coluna"));
    expect(aviso?.motivo).toContain('"Modelo"');
    expect(aviso?.motivo).not.toContain('"Marca"');
  });

  it("o aviso do arquivo sobrevive ao teto de 200 avisos de linha", () => {
    const linhas = Array.from({ length: 210 }, (_, i) => [
      String(i + 1),
      `PLACA${i}`,
      "MOTOR",
      "CHASSICURTO", // inválido → 1 aviso por linha
      null,
      100,
      null,
      "https://x/a.jpg",
      "foto",
    ]);
    const r = mapVaaptScraps(detectFile(veiculosFotos(linhas)));
    expect(r.avisos).toHaveLength(200);
    expect(r.avisos[0].motivo).toContain("Marca");
  });
});

describe("leitura — encoding e formatos que faziam o arquivo virar DESCONHECIDO", () => {
  it("CSV em latin1 (Excel BR) mantém os acentos do cabeçalho", () => {
    const texto = "# Cod Peca;Localização;Preço\n100;CX 1;10\n";
    const f = {
      fieldname: "file",
      filename: "pecas-latin1.csv",
      buffer: Buffer.from(texto, "latin1"),
    };
    expect(detectFile(f).kind).toBe("VAAPT_PECAS");
  });

  it("CSV com a diretiva sep=; do Excel não confunde o cabeçalho", () => {
    const f = {
      fieldname: "file",
      filename: "pecas-sep.csv",
      buffer: Buffer.from("sep=;\n# Cod Peca;Localizacao\n100;CX 1\n", "utf8"),
    };
    const d = detectFile(f);
    expect(d.kind).toBe("VAAPT_PECAS");
    expect(d.rows).toHaveLength(1);
    expect(d.get(d.rows[0], "Localizacao")).toBe("CX 1");
  });

  it("BOM + diretiva sep= juntos (o caso mais chato) ainda detecta", () => {
    const f = {
      fieldname: "file",
      filename: "pecas-bom-sep.csv",
      buffer: Buffer.from("﻿sep=;\n# Cod Peca;Localizacao\n100;CX 1\n", "utf8"),
    };
    expect(detectFile(f).kind).toBe("VAAPT_PECAS");
  });

  it("linha só de separadores no fim do CSV não vira registro fantasma", () => {
    const f = {
      fieldname: "file",
      filename: "pecas.csv",
      buffer: Buffer.from("# Cod Peca;Localizacao\n100;CX 1\n;;\n", "utf8"),
    };
    expect(detectFile(f).rows).toHaveLength(1);
  });

  it("workbook com aba de capa vazia usa a primeira aba COM dados", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Instruções"]]), "Capa");
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([H_VEICULOS_CLASSICO, ["36", "VW", "GOL", CHASSI, "ABC1234", null, null, "2010", "1000"]]),
      "Dados",
    );
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const d = detectFile({ fieldname: "file", filename: "multi.xlsx", buffer });
    expect(d.kind).toBe("VAAPT_VEICULOS");
    expect(d.rows).toHaveLength(1);
  });
});

describe("mensagem de erro — diz o que aconteceu com cada arquivo", () => {
  it("o erro de arquivo faltante carrega o MOTIVO de cada ignorado", () => {
    const imagens = xlsx(
      [H_PECAS_IMAGENS, [1, "T", "S", "1", "V", "CX", 1, 1, "0", "MLB1", "V1", "https://s3/a.jpg"]],
      "BackupImagesPecasEmp583.xlsx",
    );
    try {
      detectAndValidate("VAAPT", "SUCATAS", [imagens]);
      throw new Error("deveria ter lançado");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("BackupImagesPecasEmp583.xlsx");
      expect(msg).toContain("fotos das peças");
      // Nada foi aproveitado ⇒ vale sugerir conferir o sistema.
      expect(msg).toContain("SISTEMA certo");
    }
  });

  it("quando parte dos arquivos entrou, NÃO culpa a escolha do sistema", () => {
    const pecas = xlsx([H_PECAS, ["100", "MLB1", "P", "CX PR 1", "36"]], "pecas.xlsx");
    try {
      detectAndValidate("WEBDESMONTE", "VINCULOS", [
        {
          fieldname: "file",
          filename: "products.csv",
          buffer: Buffer.from("Id,Code,LocationId,PurchaseWasteId\n1,S,l,p\n", "utf8"),
        },
        pecas,
      ]);
      throw new Error("deveria ter lançado");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Falta o arquivo obrigatório");
      expect(msg).not.toContain("SISTEMA certo");
      expect(msg).toContain("pecas.xlsx");
    }
  });
});

describe("detector — os demais sistemas seguem intactos", () => {
  const csv = (text: string, name: string) => ({
    fieldname: "file",
    filename: name,
    buffer: Buffer.from(text, "utf8"),
  });

  it("WebDesmonte / IBR / IBR Soft / Dexo não são afetados pelo modelo anyOf", () => {
    const casos: Array<[string, string]> = [
      [
        "Id,Initials,Level,ParentId,InitialsPath\n1,CX,4,2,GALPÃO > CX\n",
        "WD_LOCATIONS",
      ],
      [
        "Id,Code,LocationId,PurchaseWasteId\n1,SKU1,l1,p1\n",
        "WD_PRODUCTS",
      ],
      [
        "Id,LicensePlate,Chassis,PurchaseValue\n1,ABC1234,X,100\n",
        "WD_PURCHASE_WASTE",
      ],
      [
        "Id,Name,Document,Type,CompanyId\n1,MARIA,529,F,260\n",
        "WD_CUSTOMERS",
      ],
      [
        "SKU,QuantidadeEstoque,ValorVenda,LocalizacaoSiglas\nA,1,10,G > C\n",
        "IBR_ESTOQUE",
      ],
      [
        "NumeroNotaFiscal,ChaveDeAcesso,NomeDestinatario\n1,X,MARIA\n",
        "IBR_NFE",
      ],
      [
        "codigo;valor_venda;sigla_localizacao;custo_compra\nA;10;G;5\n",
        "IBRSOFT_PRODUTOS",
      ],
      [
        "codigo_sequencial;valor_compra;certidao_baixa;chassi\n1;100;C;X\n",
        "IBRSOFT_SUCATAS",
      ],
      [
        "tipo,valor,vencimento\nPAGAR,10,2024-01-01\n",
        "DEXO_CONTAS",
      ],
    ];
    for (const [text, esperado] of casos) {
      expect(detectFile(csv(text, "x.csv")).kind, text.split("\n")[0]).toBe(
        esperado,
      );
    }
  });
});
