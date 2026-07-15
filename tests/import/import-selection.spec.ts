import { describe, it, expect } from "vitest";
import {
  inferSystemEntity,
} from "../../app/usecases/import/import-detector";
import { resolveEffectiveSelection } from "../../app/usecases/import/import-selection";
import { computePreviewHash } from "../../app/usecases/import/lib/preview-hash";
import type { ImportFile } from "../../app/usecases/import/import.types";
import { ImportValidationError } from "../../app/usecases/import/import.types";

/* Cabeçalhos reais (subconjunto suficiente p/ a assinatura de cada arquivo). */
const H = {
  produtos:
    "codigo;codigo_fabricante;criado_em;descricao;unidade;estoque;custo_compra;valor_venda;marca;modelo;lote;ano_sucata;localizacao;sigla_localizacao;placa;ncm",
  sucatas:
    "id;codigo_sequencial;codigo;ativa;status;chave_acesso_nfe;certidao_baixa;lote;marca;modelo;ano;cor;placa;chassi;ncm;valor_compra;sigla_localizacao",
  localizacoes:
    "id;sigla;descricao;caminho_siglas;caminho_descricao;caminho_hierarquia;id_pai;nivel;aceita_estoque;quantidade_maxima",
  costumers:
    "id;ativo;tipo;nome_razao_social;nome_fantasia;cpf_cnpj;rg_ie;telefone;celular;email",
  nfe: "id;numero_nota;serie;chave_acesso;protocolo;destinatario;tipo;status;valor;natureza_operacao",
  pagar:
    "id;tipo;status;favorecido;documento_favorecido;documento_conta;observacao;parcela;total_parcelas;valor_inicial;valor_atual;valor_pago;vencimento;removida;estornada",
  receber:
    "id;tipo;status;cliente;documento_cliente;documento_conta;observacao;parcela;total_parcelas;valor_inicial;valor_atual;valor_recebido;vencimento;removida;estornada",
  // WebDesmonte clássico:
  wdLoc:
    "Id,Initials,Description,HasStock,Level,ParentId,CompanyId,InitialsPath,MaxQuantity",
  wdProd: "Id,Code,Description,LocationId,PurchaseWasteId,SaleValue",
  // IBR tabular:
  ibrEstoque:
    "ProductId,SKU,BarCode,Description,Brand,Model,Active,QuantidadeEstoque,CustoReal,ValorVenda,LocationId,LocalizacaoSiglas",
  ibrNfe:
    "NumeroNotaFiscal,Serie,ChaveDeAcesso,NomeDestinatario,Situacao,ValorTotal",
};

function f(header: string, row: string, filename: string): ImportFile {
  return {
    fieldname: "file",
    filename,
    buffer: Buffer.from(`${header}\n${row}`, "utf8"),
  };
}

const IBRSOFT_FILES = (): ImportFile[] => [
  f(H.produtos, "P1;;;X;UN;1;1;10;;;;;;A;;8708", "produtos.csv"),
  f(H.sucatas, "g;1;;t;Ativa;;;;VW;GOL;2010;;ABC1234;;8708;100;", "sucatas.csv"),
  f(H.localizacoes, "g;A;A;A;;;;1;t;5", "localizacoes.csv"),
  f(H.costumers, "g;t;Pessoa fisica;JOAO;;52998224725;;;;", "costumers.csv"),
  f(H.nfe, "g;1;1;41250151781217000117550010000000501420239390;;F;Saida;Autorizada;10;VENDA", "nfe.csv"),
  f(H.pagar, "g;PAGAR;Parcial;F;1;D;;1;1;10;0;10;2024-01-01;f;f", "contas_a_pagar.csv"),
  f(H.receber, "g;RECEBER;Aberta;C;1;D;;1;1;10;10;0;2024-01-01;f;f", "contas_a_receber.csv"),
];

/* ============================ inferSystemEntity ========================= */

describe("import/inferSystemEntity", () => {
  it("os 7 CSVs do IBR Soft → IBRSOFT/PACOTE", () => {
    expect(inferSystemEntity(IBRSOFT_FILES())).toEqual({
      system: "IBRSOFT",
      entity: "PACOTE",
    });
  });

  it("subconjunto do IBR Soft (só produtos+sucatas) → IBRSOFT/PACOTE", () => {
    expect(
      inferSystemEntity([
        f(H.produtos, "P1;;;X;UN;1;1;10;;;;;;A;;8708", "produtos.csv"),
        f(H.sucatas, "g;1;;t;Ativa;;;;VW;GOL;2010;;ABC1234;;8708;100;", "sucatas.csv"),
      ]),
    ).toEqual({ system: "IBRSOFT", entity: "PACOTE" });
  });

  it("CSVs do WebDesmonte clássico → WEBDESMONTE/PACOTE", () => {
    expect(
      inferSystemEntity([
        f(H.wdLoc, "abc,CAIXA,Caixa,t,4,def,251,GALPÃO > CAIXA,10", "locations.csv"),
        f(H.wdProd, "1,SKU1,Peça,loc1,pw1,10", "products.csv"),
      ]),
    ).toEqual({ system: "WEBDESMONTE", entity: "PACOTE" });
  });

  it("IBR tabular estoque.csv → IBR/ESTOQUE", () => {
    expect(
      inferSystemEntity([
        f(H.ibrEstoque, "100,2492,,Farol,Ford,KA,t,3,15.5,160,,BARR", "estoque.csv"),
      ]),
    ).toEqual({ system: "IBR", entity: "ESTOQUE" });
  });

  it("AMBÍGUO: IBR Soft + WebDesmonte juntos → null (nunca chuta)", () => {
    expect(
      inferSystemEntity([
        f(H.produtos, "P1;;;X;UN;1;1;10;;;;;;A;;8708", "produtos.csv"),
        f(H.wdProd, "1,SKU1,Peça,loc1,pw1,10", "products.csv"),
      ]),
    ).toBeNull();
  });

  it("AMBÍGUO: IBR estoque + IBR nfe (entidades distintas) → null", () => {
    expect(
      inferSystemEntity([
        f(H.ibrEstoque, "100,2492,,Farol,Ford,KA,t,3,15.5,160,,BARR", "estoque.csv"),
        f(H.ibrNfe, "1233,1,41240,Fulano,Autorizada,100", "nfe_emitidas.csv"),
      ]),
    ).toBeNull();
  });

  it("nada reconhecido → null", () => {
    expect(inferSystemEntity([f("a,b,c", "1,2,3", "x.csv")])).toBeNull();
  });
});

/* ========================= resolveEffectiveSelection ==================== */

describe("import/resolveEffectiveSelection", () => {
  it("seleção CORRETA (IBRSOFT/PACOTE) é honrada, sem auto-detecção", () => {
    const r = resolveEffectiveSelection("IBRSOFT", "PACOTE", IBRSOFT_FILES());
    expect(r.system).toBe("IBRSOFT");
    expect(r.entity).toBe("PACOTE");
    expect(r.autoDetected).toBe(false);
    expect(r.files.length).toBe(7);
  });

  it("seleção ERRADA (WEBDESMONTE/PACOTE) com arquivos IBR Soft → corrige p/ IBRSOFT", () => {
    const r = resolveEffectiveSelection("WEBDESMONTE", "PACOTE", IBRSOFT_FILES());
    expect(r.system).toBe("IBRSOFT");
    expect(r.entity).toBe("PACOTE");
    expect(r.autoDetected).toBe(true);
    expect(r.files.length).toBe(7);
  });

  it("seleção ERRADA (IBR/ESTOQUE) com arquivos IBR Soft → corrige p/ IBRSOFT", () => {
    const r = resolveEffectiveSelection("IBR", "ESTOQUE", IBRSOFT_FILES());
    expect(r.system).toBe("IBRSOFT");
    expect(r.autoDetected).toBe(true);
  });

  it("seleção CORRETA WebDesmonte é honrada intacta (zero-regressão)", () => {
    const wd = [
      f(H.wdLoc, "abc,CAIXA,Caixa,t,4,def,251,GALPÃO > CAIXA,10", "locations.csv"),
      f(H.wdProd, "1,SKU1,Peça,loc1,pw1,10", "products.csv"),
    ];
    const r = resolveEffectiveSelection("WEBDESMONTE", "PACOTE", wd);
    expect(r.system).toBe("WEBDESMONTE");
    expect(r.autoDetected).toBe(false);
  });

  it("arquivos irreconhecíveis → propaga ImportValidationError (não silencia)", () => {
    expect(() =>
      resolveEffectiveSelection("WEBDESMONTE", "PACOTE", [
        f("a,b,c", "1,2,3", "aleatorio.csv"),
      ]),
    ).toThrow(ImportValidationError);
  });
});

/* ===================== invariante de HASH preview↔apply ================= */

describe("import/preview↔apply — hash estável sob auto-detecção", () => {
  it("hash do sistema selecionado ERRADO == hash do sistema CORRETO (mesmos arquivos)", () => {
    const files = IBRSOFT_FILES();
    const targetUserId = "admin-1";

    // Prévia: operador escolheu WEBDESMONTE, motor ajusta p/ IBRSOFT.
    const eff = resolveEffectiveSelection("WEBDESMONTE", "PACOTE", files);
    const previewHash = computePreviewHash({
      targetUserId,
      system: eff.system,
      entity: eff.entity,
      files,
    });

    // Apply: front reenvia o MESMO WEBDESMONTE (estado do dropdown) + hash.
    const effApply = resolveEffectiveSelection("WEBDESMONTE", "PACOTE", files);
    const applyHash = computePreviewHash({
      targetUserId,
      system: effApply.system,
      entity: effApply.entity,
      files,
    });

    expect(applyHash).toBe(previewHash); // sem 409

    // E também bate se o front reenviar já como IBRSOFT (seleção corrigida).
    const effApply2 = resolveEffectiveSelection("IBRSOFT", "PACOTE", files);
    const applyHash2 = computePreviewHash({
      targetUserId,
      system: effApply2.system,
      entity: effApply2.entity,
      files,
    });
    expect(applyHash2).toBe(previewHash);
  });
});
