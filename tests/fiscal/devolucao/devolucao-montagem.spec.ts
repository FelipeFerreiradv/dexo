import { describe, expect, it } from "vitest";

import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import {
  montarRascunhoDeOriginal,
  type MontarRascunhoDeOriginalInput,
  type OriginalParaDevolucao,
} from "../../../app/fiscal/devolucao/montagem";
import { modoReferenciaDevolucao } from "../../../app/fiscal/devolucao/modo-referencia";
import type { LinhaSaldoDevolucao } from "../../../app/fiscal/devolucao/saldo";
import { validarDevolucao } from "../../../app/fiscal/devolucao/validacao";
// Só tipo (apagado na compilação): o teste não carrega o parser.
import type { ParsedItem, ParsedNfe } from "../../../app/fiscal/sefaz/nfe-xml-parser.service";

const CNPJ = "11386276000176";

function chave(opts: { cnpj?: string; modelo?: string; numero?: number; serie?: number } = {}): string {
  const base =
    "41" + "2609" + (opts.cnpj ?? CNPJ) + (opts.modelo ?? "55") +
    String(opts.serie ?? 3).padStart(3, "0") + String(opts.numero ?? 3).padStart(9, "0") + "1" + "10000012";
  return base + calcularDvChaveAcesso(base)!;
}

// Focus: o banco guardou nº 12, a SEFAZ autorizou nNF 3 (chave).
const CHAVE = chave({ numero: 3, serie: 3 });

const SN102 = {
  ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
  PIS: { PISOutr: { CST: "49", vBC: "0.00", pPIS: "0.00", vPIS: "0.00" } },
  COFINS: { COFINSOutr: { CST: "49", vBC: "0.00", pCOFINS: "0.00", vCOFINS: "0.00" } },
};

function det(p: Partial<ParsedItem> & Pick<ParsedItem, "nItem" | "cProd">): ParsedItem {
  return {
    cEAN: "SEM GTIN",
    xProd: `PECA ${p.cProd}`,
    NCM: "87089990",
    CFOP: "5405",
    uCom: "UN",
    qCom: 1,
    vUnCom: 10,
    vProd: 10,
    vDesc: 0,
    CEST: null,
    imposto: SN102,
    ...p,
  };
}

function parsed(itens: ParsedItem[], extra: Partial<ParsedNfe> = {}): ParsedNfe {
  return {
    chaveAcesso: CHAVE,
    versao: "4.00",
    ide: {
      cUF: 41, natOp: "VENDA", mod: "55", serie: 3, nNF: 3,
      dhEmi: "2026-09-10T22:30:00-03:00", dhSaiEnt: null, tpNF: "1", tpAmb: "2",
      finNFe: "1", tpEmis: 1, cMunFG: "4105805", cDV: CHAVE[43],
    },
    emit: {
      CNPJ, CPF: null, xNome: "KIKO 4X4", xFant: null, IE: "123", IM: null, CNAE: null, CRT: "1",
      ender: { xLgr: "R", nro: "1", xCpl: null, xBairro: "B", cMun: "4105805", xMun: "COLOMBO", UF: "PR", CEP: "83400000", cPais: "1058", xPais: "BRASIL", fone: null },
    },
    dest: {
      CNPJ: null, CPF: "12345678909", idEstrangeiro: null,
      xNome: "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL", IE: null, indIEDest: "9", email: null, ender: null,
    },
    itens,
    total: { vBC: 0, vICMS: 0, vProd: 340, vFrete: 0, vSeg: 0, vDesc: 0, vIPI: 0, vPIS: 0, vCOFINS: 0, vOutro: 0, vNF: 340 },
    transp: null,
    pag: [{ tPag: "01", vPag: 340 }],
    infCpl: "Pedido: receivable:abc",
    protNFe: { chNFe: CHAVE, nProt: "141260000012345", dhRecbto: "2026-09-10T22:31:00-03:00", cStat: 100, xMotivo: "Autorizado o uso da NF-e", digVal: "abc=" },
    ...extra,
  };
}

const ITENS_XML = () => [
  det({ nItem: 1, cProd: "PECA-9662", qCom: 2, vUnCom: 150, vProd: 300, vDesc: 10, CFOP: "5405", CEST: "0107500" }),
  det({ nItem: 2, cProd: "FILTRO-1", qCom: 1, vUnCom: 40, vProd: 40, CFOP: "5102" }),
];

const IDENTIFICADORES_PROIBIDOS = {
  protocoloAutorizacao: "141260000012345",
  dataAutorizacao: new Date("2026-09-11T01:31:00Z"),
  xmlAssinadoPath: "fiscal/u1/xml/assinado-orig.xml",
  danfePdfPath: "fiscal/u1/danfe/orig.pdf",
  motivoRejeicao: "Rejeicao antiga",
  cStatRejeicao: 225,
  orderId: "order-777",
  numeroPedido: "receivable:abc",
};

function original(extra: Partial<OriginalParaDevolucao> = {}): OriginalParaDevolucao {
  const base = {
    id: "orig-1",
    status: "AUTHORIZED",
    modelo: "55",
    finalidade: "NORMAL",
    tipoOperacao: "SAIDA",
    destinoOperacao: "INTERNA",
    ambiente: "HOMOLOGACAO",
    serie: 3,
    numero: 12,
    chaveAcesso: "NFe" + CHAVE,
    companyFiscalConfigId: "cfg-1",
    customerId: "cust-1",
    destinatarioJson: { tipoPessoa: "PF", cpfCnpj: "123.456.789-09", nome: "JOAO DA SILVA" },
    dataEmissao: new Date("2026-09-11T01:30:00Z"),
    xmlAutorizadoPath: "fiscal/u1/xml/autorizado-orig.xml",
    ...IDENTIFICADORES_PROIBIDOS,
    ...extra,
  };
  return base;
}

function input(over: Partial<MontarRascunhoDeOriginalInput> = {}): MontarRascunhoDeOriginalInput {
  return {
    original: original(),
    parsed: parsed(ITENS_XML()),
    idDestOriginal: 1,
    config: { id: "cfg-1", cnpj: "11.386.276/0001-76", regimeTributario: "SIMPLES", serieNfe: 5, ambiente: "HOMOLOGACAO" },
    linhasSaldo: [],
    itensNfe: [
      { numero: 1, codigo: "PECA-9662", quantidade: "2.0000", valorTotal: "300.00", productId: "prod-9662" },
      { numero: 2, codigo: "FILTRO-1", quantidade: 1, valorTotal: 40, productId: "prod-filtro" },
    ],
    escopo: "TOTAL",
    tipo: "VENDA_ENTRADA",
    ...over,
  };
}

const saldo = (nItem: number, quantidade: number, statusDevolucao: string, id = "dev-x"): LinhaSaldoDevolucao => ({
  chave: CHAVE,
  nItem,
  quantidade,
  statusDevolucao,
  devolucaoNfeId: id,
});

describe("montarRascunhoDeOriginal — nunca copia identificadores", () => {
  it("cabeçalho tem exatamente as chaves do rascunho, sem id/chave/protocolo/xml/status/numero/pedido", () => {
    const r = montarRascunhoDeOriginal(input());
    expect(Object.keys(r.cabecalho).sort()).toEqual(
      [
        "tipoOperacao", "finalidade", "modelo", "destinoOperacao", "indPresenca", "modalidadeFrete",
        "pagamentosJson", "duplicatasJson", "notasReferenciadasJson", "naturezaOperacao",
        "informacoesComplementares", "serie", "ambiente", "companyFiscalConfigId", "customerId", "destinatarioJson",
      ].sort(),
    );
    const proibidas = [
      "id", "chaveAcesso", "protocoloAutorizacao", "dataAutorizacao", "xmlAutorizadoPath", "xmlAssinadoPath",
      "xmlOriginalPath", "danfePdfPath", "status", "numero", "motivoRejeicao", "cStatRejeicao", "orderId", "numeroPedido",
    ];
    for (const k of proibidas) expect(r.cabecalho).not.toHaveProperty(k);

    const texto = JSON.stringify({ cabecalho: r.cabecalho, itens: r.itens });
    for (const v of ["orig-1", "141260000012345", "assinado-orig.xml", "autorizado-orig.xml", "orig.pdf", "order-777", "receivable:abc", "Rejeicao antiga"]) {
      expect(texto).not.toContain(v);
    }
    for (const it of r.itens) {
      expect(Object.keys(it).sort()).toEqual(
        ["numero", "productId", "codigo", "descricao", "ncm", "cfop", "cest", "origem", "unidade", "quantidade", "valorUnitario", "valorTotal", "desconto", "observacoes"].sort(),
      );
    }
  });

  it("cabeçalho de devolução de venda: ENTRADA/DEVOLUCAO/55, sem frete, tPag 90, série/ambiente/emitente da config", () => {
    const r = montarRascunhoDeOriginal(input());
    expect(r.cabecalho).toMatchObject({
      tipoOperacao: "ENTRADA",
      finalidade: "DEVOLUCAO",
      modelo: "55",
      destinoOperacao: "INTERNA",
      indPresenca: "NAO_SE_APLICA",
      modalidadeFrete: "SEM_FRETE",
      pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
      duplicatasJson: null,
      notasReferenciadasJson: null,
      naturezaOperacao: "DEVOLUCAO DE VENDA",
      serie: 5,
      ambiente: "HOMOLOGACAO",
      companyFiscalConfigId: "cfg-1",
      customerId: "cust-1",
    });
    expect(r.indFinal).toBe("1");
    expect(r.tipo).toBe("VENDA_ENTRADA");
    expect(r.fonte).toBe("DEXO");
  });

  it("idDest espelha a original (2 → INTERESTADUAL, CFOP 2xxx)", () => {
    const p = parsed([det({ nItem: 1, cProd: "A", CFOP: "6102" })]);
    const r = montarRascunhoDeOriginal(input({ parsed: p, idDestOriginal: 2 }));
    expect(r.cabecalho.destinoOperacao).toBe("INTERESTADUAL");
    expect(r.itens[0].cfop).toBe("2202");
  });

  it("destinatário vem de destinatarioJson (cópia), nunca do xNome de homologação do XML", () => {
    const o = original();
    const r = montarRascunhoDeOriginal(input({ original: o }));
    expect(r.cabecalho.destinatarioJson).toEqual(o.destinatarioJson);
    expect(r.cabecalho.destinatarioJson).not.toBe(o.destinatarioJson);
    expect(JSON.stringify(r.cabecalho)).not.toContain("SEM VALOR FISCAL");
  });

  it("texto da referência usa nNF/série REAIS da chave (3), não o número do banco (12)", () => {
    const r = montarRascunhoDeOriginal(input());
    expect(r.cabecalho.informacoesComplementares).toBe(`Devolucao ref. NF-e 3 serie 3 de 10/09/2026, chave ${CHAVE}`);
    expect(r.origem).toMatchObject({ chaveAcesso: CHAVE, numero: 3, serie: 3, modelo: "55", dataEmissao: "2026-09-10", originalNfeId: "orig-1" });
  });

  it("original NFC-e: rótulo NFC-e e aviso quando não há destinatário", () => {
    const k65 = chave({ modelo: "65", numero: 77, serie: 1 });
    const p = parsed([det({ nItem: 1, cProd: "A", CFOP: "5102" })], { chaveAcesso: k65 });
    const r = montarRascunhoDeOriginal(
      input({ parsed: p, original: original({ modelo: "65", chaveAcesso: k65, destinatarioJson: {} }) }),
    );
    expect(r.cabecalho.informacoesComplementares).toBe(`Devolucao ref. NFC-e 77 serie 1 de 10/09/2026, chave ${k65}`);
    expect(r.cabecalho.destinatarioJson).toBeNull();
    expect(r.issues.find((i) => i.code === "DESTINATARIO_AUSENTE")?.severidade).toBe("AVISO");
  });

  it("não produz o número placeholder (é do repositório) e não inventa data sem dhEmi", () => {
    const semData = parsed(ITENS_XML());
    semData.ide = { ...semData.ide, dhEmi: null };
    const r = montarRascunhoDeOriginal(input({ parsed: semData, original: original({ dataEmissao: null }) }));
    expect(r.cabecalho).not.toHaveProperty("numero");
    expect(r.cabecalho.informacoesComplementares).toBe(`Devolucao ref. NF-e 3 serie 3, chave ${CHAVE}`);
  });
});

describe("montarRascunhoDeOriginal — itens, referências e saldo", () => {
  it("total: um item por det, numero = ordem, valores do XML, CFOP mapeado, productId pareado", () => {
    const r = montarRascunhoDeOriginal(input());
    expect(r.itens).toEqual([
      {
        numero: 1, productId: "prod-9662", codigo: "PECA-9662", descricao: "PECA PECA-9662", ncm: "87089990",
        cfop: "1411", cest: "0107500", origem: 0, unidade: "UN", quantidade: 2, valorUnitario: 150,
        valorTotal: 300, desconto: 10, observacoes: null,
      },
      {
        numero: 2, productId: "prod-filtro", codigo: "FILTRO-1", descricao: "PECA FILTRO-1", ncm: "87089990",
        cfop: "1202", cest: null, origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 40,
        valorTotal: 40, desconto: null, observacoes: null,
      },
    ]);
    expect(r.refs.map((x) => [x.ordem, x.chaveAcessoOriginal, x.nItemOriginal, x.codigoOriginal, x.quantidadeOriginal, x.quantidade, x.valor]))
      .toEqual([
        [1, CHAVE, 1, "PECA-9662", 2, 2, 300],
        [2, CHAVE, 2, "FILTRO-1", 1, 1, 40],
      ]);
    expect(r.refs[0].originalNfeId).toBe("orig-1");
    expect(r.refs[0].tributacao.icms.tag).toBe("ICMSSN102");
    expect(r.refs[0].tributacao.requerRevisao).toBe(false);
    expect(r.refs[0].impostoOriginal?.icms?.csosn).toBe("102");
    expect(r.origem.itens).toHaveLength(2);
    // Só falta a resposta "foi entregue?" — o resto está pronto.
    // ATUALIZADO (onda 5, decisão 4 do dono): o XML desta venda do Simples traz
    // PIS/COFINS 49 (CST de SAÍDA) e a devolução de venda é nota de ENTRADA — o
    // servidor agora AVISA isso, igual ao campo da tela (antes só a tela avisava).
    // É AVISO: o único impedimento continua sendo a resposta da entrega.
    expect(r.issues.filter((i) => i.severidade === "ERRO").map((i) => i.code)).toEqual(["ESCOLHA_PENDENTE"]);
    expect(r.issues.filter((i) => i.severidade === "AVISO").map((i) => [i.code, i.ordem])).toEqual([
      ["PIS_CST_SAIDA_EM_ENTRADA", 1],
      ["PIS_CST_SAIDA_EM_ENTRADA", 2],
    ]);
    expect(r.issues).toHaveLength(3);
  });

  it("parcial: saldo desconta autorizada/em processamento; item zerado sai e o nItem não é posicional", () => {
    const linhas = [saldo(1, 2, "AUTHORIZED", "d1"), saldo(2, 0.5, "SENDING", "d2"), saldo(2, 0.5, "REJECTED", "d3")];
    const r = montarRascunhoDeOriginal(input({ linhasSaldo: linhas, escopo: "PARCIAL" }));
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0]).toMatchObject({ numero: 1, codigo: "FILTRO-1", quantidade: 0.5, valorTotal: 20 });
    expect(r.refs[0]).toMatchObject({ ordem: 1, nItemOriginal: 2, quantidade: 0.5, quantidadeOriginal: 1 });
    expect(r.saldos.find((s) => s.nItem === 2)).toMatchObject({ emProcessamento: 0.5, emRascunho: 0.5, disponivel: 0.5 });
    const codes = r.issues.map((i) => i.code);
    expect(codes).not.toContain("PARCIALMENTE_DEVOLVIDA");
    expect(codes).toContain("EMISSAO_EM_ANDAMENTO");
  });

  it("escopo TOTAL com nota já parcialmente devolvida → PARCIALMENTE_DEVOLVIDA", () => {
    const r = montarRascunhoDeOriginal(input({ linhasSaldo: [saldo(1, 1, "AUTHORIZED")], escopo: "TOTAL" }));
    expect(r.issues.find((i) => i.code === "PARCIALMENTE_DEVOLVIDA")?.severidade).toBe("ERRO");
    expect(r.itens[0]).toMatchObject({ quantidade: 1, valorTotal: 150, desconto: 5 });
  });

  it("tudo devolvido → nenhum item e TOTALMENTE_DEVOLVIDA; cancelada/rejeitada não contam", () => {
    const tudo = montarRascunhoDeOriginal(input({ linhasSaldo: [saldo(1, 2, "AUTHORIZED"), saldo(2, 1, "AUTHORIZED")] }));
    expect(tudo.itens).toEqual([]);
    expect(tudo.refs).toEqual([]);
    expect(tudo.issues.map((i) => i.code)).toEqual(["TOTALMENTE_DEVOLVIDA"]);

    const liberado = montarRascunhoDeOriginal(input({ linhasSaldo: [saldo(1, 2, "CANCELLED"), saldo(2, 1, "REJECTED")] }));
    expect(liberado.itens.map((i) => i.quantidade)).toEqual([2, 1]);
  });

  it("saldo de outra chave não interfere", () => {
    const outra: LinhaSaldoDevolucao = { ...saldo(1, 2, "AUTHORIZED"), chave: chave({ numero: 99 }) };
    const r = montarRascunhoDeOriginal(input({ linhasSaldo: [outra] }));
    expect(r.itens).toHaveLength(2);
  });

  it("productId só com par único (código + quantidade + valor)", () => {
    const r = montarRascunhoDeOriginal(
      input({
        itensNfe: [
          { numero: 1, codigo: "PECA-9662", quantidade: 2, valorTotal: 300, productId: "a" },
          { numero: 7, codigo: "PECA-9662", quantidade: 2, valorTotal: 300, productId: "b" },
          { numero: 2, codigo: "FILTRO-1", quantidade: 3, valorTotal: 40, productId: "c" },
        ],
      }),
    );
    expect(r.itens.map((i) => i.productId)).toEqual([null, null]);
  });

  it("CFOP sem inverso único fica vazio e bloqueia (CFOP_ESCOLHA_PENDENTE)", () => {
    const p = parsed([det({ nItem: 1, cProd: "A", CFOP: "6404" })]);
    const r = montarRascunhoDeOriginal(input({ parsed: p, idDestOriginal: 2 }));
    expect(r.itens[0].cfop).toBe("");
    expect(r.refs[0].cfopMapeamento).toMatchObject({ status: "ESCOLHA", opcoes: ["2411", "2949"] });
    expect(r.issues.find((i) => i.code === "CFOP_ESCOLHA_PENDENTE")).toMatchObject({ severidade: "ERRO", ordem: 1 });
  });

  it("tributação que exige revisão aparece como issue de item", () => {
    const p = parsed([
      det({
        nItem: 1, cProd: "A", qCom: 3, vUnCom: 100, vProd: 300,
        imposto: { ...SN102, IPI: { cEnq: "999", IPITrib: { CST: "50", vBC: "300.00", pIPI: "10.00", vIPI: "30.00" } } },
      }),
    ]);
    const r = montarRascunhoDeOriginal(input({ parsed: p }));
    expect(r.refs[0].tributacao.ipiDevol).toEqual({ pDevol: 100, vIPIDevol: 30 });
    expect(r.issues.find((i) => i.code === "TRIBUTACAO_REVISAO_PENDENTE")?.ordem).toBe(1);
  });
});

describe("montarRascunhoDeOriginal — elegibilidade", () => {
  it("original cancelada → ORIGINAL_CANCELADA", () => {
    const r = montarRascunhoDeOriginal(input({ original: original({ status: "CANCELLED" }) }));
    expect(r.issues.map((i) => i.code)).toContain("ORIGINAL_CANCELADA");
  });

  it("original que já é devolução ou de entrada", () => {
    const dev = montarRascunhoDeOriginal(input({ original: original({ finalidade: "DEVOLUCAO" }) }));
    expect(dev.issues.map((i) => i.code)).toContain("JA_E_DEVOLUCAO");
    const ent = montarRascunhoDeOriginal(input({ original: original({ tipoOperacao: "ENTRADA" }) }));
    expect(ent.issues.map((i) => i.code)).toContain("ORIGINAL_ENTRADA");
  });

  it("chave do banco diferente da do XML → CHAVE_DIVERGENTE; XML sem cStat 100/150 → XML_SEM_AUTORIZACAO", () => {
    const r = montarRascunhoDeOriginal(input({ original: original({ chaveAcesso: chave({ numero: 4 }) }) }));
    expect(r.issues.map((i) => i.code)).toContain("CHAVE_DIVERGENTE");
    const p = parsed(ITENS_XML());
    p.protNFe = { ...p.protNFe!, cStat: 204 };
    expect(montarRascunhoDeOriginal(input({ parsed: p })).issues.map((i) => i.code)).toContain("XML_SEM_AUTORIZACAO");
  });

  it("emitente da config diferente do CNPJ da chave → EMITENTE_ORIGINAL_DIVERGENTE", () => {
    const r = montarRascunhoDeOriginal(
      input({ config: { id: "cfg-2", cnpj: "07504505000132", regimeTributario: "SIMPLES", serieNfe: 1, ambiente: "HOMOLOGACAO" } }),
    );
    expect(r.issues.map((i) => i.code)).toContain("EMITENTE_ORIGINAL_DIVERGENTE");
  });

  it("ambiente da original ≠ config → AMBIENTE_DIVERGENTE", () => {
    const r = montarRascunhoDeOriginal(input({ original: original({ ambiente: "PRODUCAO" }) }));
    expect(r.issues.map((i) => i.code)).toContain("AMBIENTE_DIVERGENTE");
  });
});

describe("1010 impossível por construção", () => {
  it("o rascunho nunca leva notas referenciadas e o modo é um só por (ambiente, data)", () => {
    const r = montarRascunhoDeOriginal(input());
    expect(r.cabecalho.notasReferenciadasJson).toBeNull();
    const issues = validarDevolucao({
      cabecalho: { tipo: "VENDA_ENTRADA", devolvidaAposEntrega: true },
      nota: { ...r.cabecalho, destinatarioCpfCnpj: r.cabecalho.destinatarioJson?.cpfCnpj ?? null },
      emitente: { cnpj: CNPJ, crt: "1" },
      itens: r.itens,
      refs: r.refs.map((x) => ({
        ordem: x.ordem, chaveAcesso: x.chaveAcessoOriginal, nItem: x.nItemOriginal, codigoOriginal: x.codigoOriginal,
        quantidade: x.quantidade, quantidadeOriginal: x.quantidadeOriginal, tributacao: x.tributacao,
      })),
      saldos: r.saldos.map((s) => ({ chaveAcesso: CHAVE, nItem: s.nItem, disponivel: s.disponivel })),
      originais: [{ chaveAcesso: CHAVE, status: "AUTHORIZED", ambiente: "HOMOLOGACAO" }],
      idDestOriginal: 1,
    });
    // ATUALIZADO (onda 5, decisão 4 do dono): o PIS/COFINS 49 herdado desta
    // venda do Simples, numa devolução de venda (nota de entrada), agora gera o
    // AVISO PIS_CST_SAIDA_EM_ENTRADA também no servidor. Nenhuma pendência de
    // referência (o que este teste prende: 1010 impossível) nem nenhum ERRO.
    expect(issues.filter((i) => i.severidade === "ERRO")).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(["PIS_CST_SAIDA_EM_ENTRADA", "PIS_CST_SAIDA_EM_ENTRADA"]);
    for (const amb of ["HOMOLOGACAO", "PRODUCAO"]) {
      for (const d of ["2026-10-04T12:00:00Z", "2026-10-05T12:00:00Z"]) {
        expect(["ITEM", "NOTA"]).toContain(modoReferenciaDevolucao(amb, new Date(d), "2026-10-05"));
      }
    }
  });
});
