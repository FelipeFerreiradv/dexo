import { describe, expect, it } from "vitest";

import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import type { DevolucaoIssue } from "../../../app/fiscal/devolucao/tipos";
import { normalizarImpostoOriginal, proporcionalizar } from "../../../app/fiscal/devolucao/tributacao";
import {
  issuesBloqueantes,
  temBloqueio,
  validarDevolucao,
  type ContextoValidacaoDevolucao,
} from "../../../app/fiscal/devolucao/validacao";

const CNPJ = "11386276000176";

function chave(opts: { cnpj?: string; modelo?: string; numero?: number; dvErrado?: boolean } = {}): string {
  const base =
    "41" + "2609" + (opts.cnpj ?? CNPJ) + (opts.modelo ?? "55") + "003" +
    String(opts.numero ?? 12).padStart(9, "0") + "1" + "10000012";
  const dv = calcularDvChaveAcesso(base)!;
  return base + (opts.dvErrado ? String((Number(dv) + 1) % 10) : dv);
}

const CHAVE = chave();

// ATUALIZADO (onda 5, decisão 4 do dono): o PIS/COFINS da base "caso válido"
// passou de 49 para 99. O 49 é CST de SAÍDA; numa devolução de venda (nota de
// ENTRADA) ele agora gera o AVISO PIS_CST_SAIDA_EM_ENTRADA também no servidor —
// antes só a tela avisava. A base deste arquivo é o contexto SEM pendência
// nenhuma, e as regras daqui (cabeçalho, CFOP, saldo…) não são sobre PIS: o 99
// ("outras operações", serve para entrada e para saída) mantém cada teste
// testando só a regra dele. O 49 herdado tem o seu próprio teste abaixo
// ("49 herdado numa devolução de venda…").
const tribOk = (cstPisCofins = "99") =>
  proporcionalizar({
    impostoOriginal: normalizarImpostoOriginal({
      ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
      PIS: { PISOutr: { CST: cstPisCofins, vBC: "0.00", pPIS: "0.00", vPIS: "0.00" } },
      COFINS: { COFINSOutr: { CST: cstPisCofins, vBC: "0.00", pCOFINS: "0.00", vCOFINS: "0.00" } },
    }),
    qOriginal: 2,
    qDevolvida: 1,
    vUnCom: 150,
    crtEmitente: "1",
    crtOriginal: "1",
  });

function ctxBase(): ContextoValidacaoDevolucao {
  return {
    cabecalho: { tipo: "VENDA_ENTRADA", devolvidaAposEntrega: true, confirmadoSemXml: false },
    nota: {
      modelo: "55",
      finalidade: "DEVOLUCAO",
      tipoOperacao: "ENTRADA",
      destinoOperacao: "INTERNA",
      ambiente: "HOMOLOGACAO",
      destinatarioCpfCnpj: "123.456.789-09",
      notasReferenciadasJson: null,
      pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
      duplicatasJson: null,
    },
    emitente: { cnpj: "11.386.276/0001-76", crt: "1" },
    itens: [{ numero: 1, codigo: "PECA-9662", quantidade: 1, cfop: "1202" }],
    refs: [
      {
        ordem: 1,
        chaveAcesso: CHAVE,
        nItem: 1,
        codigoOriginal: "PECA-9662",
        quantidade: "1.0000",
        quantidadeOriginal: 2,
        tributacao: tribOk(),
      },
    ],
    saldos: [{ chaveAcesso: CHAVE, nItem: 1, disponivel: 2 }],
    originais: [{ chaveAcesso: "NFe" + CHAVE, status: "AUTHORIZED", ambiente: "HOMOLOGACAO" }],
    idDestOriginal: 1,
  };
}

const codigos = (issues: DevolucaoIssue[]) => issues.map((i) => i.code);
const achar = (issues: DevolucaoIssue[], code: string) => issues.find((i) => i.code === code);

describe("validarDevolucao — caso válido", () => {
  it("contexto completo e coerente não gera issue", () => {
    const issues = validarDevolucao(ctxBase());
    expect(issues).toEqual([]);
    expect(temBloqueio(issues)).toBe(false);
  });

  it("original NFC-e (65) é referenciável", () => {
    const ctx = ctxBase();
    const k = chave({ modelo: "65" });
    ctx.refs[0].chaveAcesso = k;
    ctx.saldos = [{ chaveAcesso: k, nItem: 1, disponivel: 2 }];
    ctx.originais = [{ chaveAcesso: k, status: "AUTHORIZED", ambiente: "HOMOLOGACAO" }];
    expect(validarDevolucao(ctx)).toEqual([]);
  });
});

describe("validarDevolucao — cabeçalho", () => {
  it("devolvidaAposEntrega null → ESCOLHA_PENDENTE; false → RECUSA_NAO_E_DEVOLUCAO", () => {
    const a = ctxBase();
    a.cabecalho!.devolvidaAposEntrega = null;
    expect(codigos(validarDevolucao(a))).toEqual(["ESCOLHA_PENDENTE"]);
    const b = ctxBase();
    b.cabecalho!.devolvidaAposEntrega = false;
    const issues = validarDevolucao(b);
    expect(codigos(issues)).toEqual(["RECUSA_NAO_E_DEVOLUCAO"]);
    expect(issues[0].severidade).toBe("ERRO");
    expect(issues[0].mensagem).toMatch(/finNFe 5/);
  });

  it("sem cabeçalho (devolução não gerenciada) → NAO_GERENCIADA (321)", () => {
    const ctx = ctxBase();
    ctx.cabecalho = null;
    const i = achar(validarDevolucao(ctx), "NAO_GERENCIADA")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).toMatch(/321/);
  });

  it("finalidade diferente de DEVOLUCAO → FINALIDADE_NAO_DEVOLUCAO (328)", () => {
    const ctx = ctxBase();
    ctx.nota.finalidade = "NORMAL";
    const i = achar(validarDevolucao(ctx), "FINALIDADE_NAO_DEVOLUCAO")!;
    expect(i.mensagem).toMatch(/328/);
  });

  it("modelo 65 → MODELO_NAO_PERMITIDO", () => {
    const ctx = ctxBase();
    ctx.nota.modelo = "65";
    expect(codigos(validarDevolucao(ctx))).toEqual(["MODELO_NAO_PERMITIDO"]);
  });

  it("VENDA_ENTRADA emitida como SAIDA → TIPO_OPERACAO_INCOERENTE", () => {
    const ctx = ctxBase();
    ctx.nota.tipoOperacao = "SAIDA";
    expect(codigos(validarDevolucao(ctx))).toContain("TIPO_OPERACAO_INCOERENTE");
  });

  it("1010: notas referenciadas do formulário junto com a referência → NFREF_PROIBIDA", () => {
    const ctx = ctxBase();
    ctx.nota.notasReferenciadasJson = [{ chaveAcesso: CHAVE }];
    const i = achar(validarDevolucao(ctx), "NFREF_PROIBIDA")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).toMatch(/1010/);
    const vazio = ctxBase();
    vazio.nota.notasReferenciadasJson = [];
    expect(validarDevolucao(vazio)).toEqual([]);
  });

  it("871: pagamento diferente de 90 é só AVISO (o servidor força tPag 90); duplicatas também", () => {
    const ctx = ctxBase();
    ctx.nota.pagamentosJson = [{ meio: "DINHEIRO", valor: 150 }];
    ctx.nota.duplicatasJson = [{ numero: "001", valor: 150 }];
    const issues = validarDevolucao(ctx);
    expect(codigos(issues)).toEqual(["PAGAMENTO_SERA_90", "COBRANCA_NAO_ENVIADA"]);
    expect(issues.every((i) => i.severidade === "AVISO")).toBe(true);
    expect(issues[0].mensagem).toMatch(/871/);
    expect(temBloqueio(issues)).toBe(false);
    expect(issuesBloqueantes(issues)).toEqual([]);
  });

  it("idDest diferente da original → IDDEST_DIVERGENTE_ORIGINAL", () => {
    const ctx = ctxBase();
    ctx.idDestOriginal = 2;
    expect(codigos(validarDevolucao(ctx))).toEqual(["IDDEST_DIVERGENTE_ORIGINAL"]);
  });
});

describe("validarDevolucao — referências", () => {
  it("321: sem referência nenhuma → REFERENCIA_AUSENTE", () => {
    const ctx = ctxBase();
    ctx.refs = [];
    const i = achar(validarDevolucao(ctx), "REFERENCIA_AUSENTE")!;
    expect(i.mensagem).toMatch(/321/);
  });

  it("321: item sem referência na posição → REFERENCIA_AUSENTE do item + ITENS_DESALINHADOS", () => {
    const ctx = ctxBase();
    ctx.itens.push({ numero: 2, codigo: "OUTRA", quantidade: 1, cfop: "1202" });
    const issues = validarDevolucao(ctx);
    expect(issues.find((i) => i.code === "REFERENCIA_AUSENTE")?.ordem).toBe(2);
    expect(codigos(issues)).toContain("ITENS_DESALINHADOS");
  });

  it("sem itens → SEM_ITENS", () => {
    const ctx = ctxBase();
    ctx.itens = [];
    expect(codigos(validarDevolucao(ctx))).toEqual(expect.arrayContaining(["SEM_ITENS", "REFERENCIA_AUSENTE"]));
  });

  it("ITENS_DESALINHADOS: código, quantidade ou posição divergentes", () => {
    const cod = ctxBase();
    cod.itens[0].codigo = "OUTRO";
    expect(codigos(validarDevolucao(cod))).toEqual(["ITENS_DESALINHADOS"]);
    const qtd = ctxBase();
    qtd.itens[0].quantidade = 2;
    expect(codigos(validarDevolucao(qtd))).toEqual(["ITENS_DESALINHADOS"]);
    const pos = ctxBase();
    pos.itens[0].numero = 2;
    pos.refs[0].ordem = 2;
    expect(codigos(validarDevolucao(pos))).toContain("ITENS_DESALINHADOS");
  });

  it("chave com DV errado → CHAVE_INVALIDA; modelo 57 → MODELO_ORIGINAL_NAO_SUPORTADO", () => {
    const dv = ctxBase();
    dv.refs[0].chaveAcesso = chave({ dvErrado: true });
    expect(codigos(validarDevolucao(dv))).toContain("CHAVE_INVALIDA");
    const m57 = ctxBase();
    m57.refs[0].chaveAcesso = chave({ modelo: "57" });
    expect(codigos(validarDevolucao(m57))).toContain("MODELO_ORIGINAL_NAO_SUPORTADO");
  });

  it("1048: nItem fora de 1..990 → NITEM_INVALIDO", () => {
    for (const nItem of [0, 991, 1.5]) {
      const ctx = ctxBase();
      ctx.refs[0].nItem = nItem;
      const i = achar(validarDevolucao(ctx), "NITEM_INVALIDO")!;
      expect(i.ordem).toBe(1);
      expect(i.mensagem).toMatch(/1048/);
    }
  });

  it("1072: mesmo par chave+nItem duas vezes → REFERENCIA_DUPLICADA", () => {
    const ctx = ctxBase();
    ctx.itens.push({ numero: 2, codigo: "PECA-9662", quantidade: 1, cfop: "1202" });
    ctx.refs.push({ ...ctx.refs[0], ordem: 2, chaveAcesso: "NFe" + CHAVE });
    const i = achar(validarDevolucao(ctx), "REFERENCIA_DUPLICADA")!;
    expect(i.ordem).toBe(2);
    expect(i.mensagem).toMatch(/1072/);
  });

  it("1193: chaves de emitentes diferentes → EMITENTES_DIVERSOS", () => {
    const ctx = ctxBase();
    const outra = chave({ cnpj: "07504505000132" });
    ctx.itens.push({ numero: 2, codigo: "X", quantidade: 1, cfop: "1202" });
    ctx.refs.push({ ...ctx.refs[0], ordem: 2, chaveAcesso: outra, codigoOriginal: "X" });
    ctx.saldos!.push({ chaveAcesso: outra, nItem: 1, disponivel: 1 });
    const i = achar(validarDevolucao(ctx), "EMITENTES_DIVERSOS")!;
    expect(i.mensagem).toMatch(/1193/);
  });

  it("VENDA_ENTRADA: nota original de outro CNPJ → EMITENTE_ORIGINAL_DIVERGENTE", () => {
    const ctx = ctxBase();
    ctx.emitente.cnpj = "07504505000132";
    expect(codigos(validarDevolucao(ctx))).toEqual(["EMITENTE_ORIGINAL_DIVERGENTE"]);
  });

  it("1194: COMPRA_SAIDA exige destinatário = emitente da chave", () => {
    const fornecedor = "07504505000132";
    const k = chave({ cnpj: fornecedor });
    const ctx = ctxBase();
    ctx.cabecalho!.tipo = "COMPRA_SAIDA";
    ctx.nota.tipoOperacao = "SAIDA";
    ctx.itens[0].cfop = "5202";
    ctx.refs[0].chaveAcesso = k;
    ctx.saldos = [{ chaveAcesso: k, nItem: 1, disponivel: 2 }];
    ctx.originais = [];
    ctx.nota.destinatarioCpfCnpj = "99.999.999/0001-91";
    const i = achar(validarDevolucao(ctx), "DESTINATARIO_NAO_E_EMITENTE_ORIGINAL")!;
    expect(i.mensagem).toMatch(/1194/);

    ctx.nota.destinatarioCpfCnpj = "07.504.505/0001-32";
    expect(validarDevolucao(ctx)).toEqual([]);
  });
});

describe("validarDevolucao — CFOP", () => {
  it("327: CFOP de venda → CFOP_NAO_DEVOLUCAO; vazio → CFOP_ESCOLHA_PENDENTE", () => {
    const venda = ctxBase();
    venda.itens[0].cfop = "5102";
    const i = achar(validarDevolucao(venda), "CFOP_NAO_DEVOLUCAO")!;
    expect(i.mensagem).toMatch(/327/);
    const vazio = ctxBase();
    vazio.itens[0].cfop = "";
    expect(achar(validarDevolucao(vazio), "CFOP_ESCOLHA_PENDENTE")!.mensagem).toMatch(/327/);
  });

  it("327: 1949 vale na entrada e não na saída", () => {
    const ent = ctxBase();
    ent.itens[0].cfop = "1949";
    expect(validarDevolucao(ent)).toEqual([]);
    const sai = ctxBase();
    sai.cabecalho!.tipo = "COMPRA_SAIDA";
    sai.nota.tipoOperacao = "SAIDA";
    sai.itens[0].cfop = "1949";
    expect(codigos(validarDevolucao(sai))).toContain("CFOP_NAO_DEVOLUCAO");
  });

  it("CFOP de saída numa entrada → CFOP_SENTIDO_INVALIDO", () => {
    const ctx = ctxBase();
    ctx.itens[0].cfop = "5202";
    expect(codigos(validarDevolucao(ctx))).toEqual(["CFOP_SENTIDO_INVALIDO"]);
  });

  it("731/732/733: 1º dígito × idDest", () => {
    const c732 = ctxBase();
    c732.itens[0].cfop = "2202";
    expect(achar(validarDevolucao(c732), "CFOP_IDDEST_DIVERGENTE")!.mensagem).toMatch(/732/);

    const c733 = ctxBase();
    c733.nota.destinoOperacao = "INTERESTADUAL";
    c733.idDestOriginal = 2;
    expect(achar(validarDevolucao(c733), "CFOP_IDDEST_DIVERGENTE")!.mensagem).toMatch(/733/);

    const c731 = ctxBase();
    c731.itens[0].cfop = "3202";
    expect(achar(validarDevolucao(c731), "CFOP_IDDEST_DIVERGENTE")!.mensagem).toMatch(/731/);
  });

  it("1179: MEI só usa a lista restrita", () => {
    const ctx = ctxBase();
    ctx.emitente.crt = "4";
    ctx.itens[0].cfop = "1411";
    const i = achar(validarDevolucao(ctx), "CFOP_MEI_NAO_PERMITIDO")!;
    expect(i.mensagem).toMatch(/1179/);
    ctx.itens[0].cfop = "1202";
    expect(codigos(validarDevolucao(ctx))).not.toContain("CFOP_MEI_NAO_PERMITIDO");
  });
});

describe("validarDevolucao — quantidade, saldo e original", () => {
  it("quantidade zero ou com 5 casas → QUANTIDADE_INVALIDA", () => {
    const zero = ctxBase();
    zero.refs[0].quantidade = 0;
    zero.itens[0].quantidade = 0;
    expect(codigos(validarDevolucao(zero))).toEqual(["QUANTIDADE_INVALIDA"]);
    const casas = ctxBase();
    casas.refs[0].quantidade = 1.00001;
    casas.itens[0].quantidade = 1.00001;
    expect(codigos(validarDevolucao(casas))).toContain("QUANTIDADE_INVALIDA");
  });

  it("acima do disponível → SALDO_EXCEDIDO", () => {
    const ctx = ctxBase();
    ctx.saldos = [{ chaveAcesso: CHAVE, nItem: 1, disponivel: 0.5 }];
    const i = achar(validarDevolucao(ctx), "SALDO_EXCEDIDO")!;
    expect(i.ordem).toBe(1);
    expect(i.severidade).toBe("ERRO");
  });

  it("sem saldo calculado, usa a quantidade original como teto", () => {
    const ctx = ctxBase();
    ctx.saldos = null;
    ctx.refs[0].quantidade = 3;
    ctx.itens[0].quantidade = 3;
    expect(codigos(validarDevolucao(ctx))).toEqual(["SALDO_EXCEDIDO"]);
  });

  it("sem saldo e sem quantidade original: exige confirmadoSemXml", () => {
    const ctx = ctxBase();
    ctx.saldos = [];
    ctx.refs[0].quantidadeOriginal = null;
    expect(codigos(validarDevolucao(ctx))).toEqual(["SALDO_NAO_VERIFICAVEL"]);
    ctx.cabecalho!.confirmadoSemXml = true;
    expect(validarDevolucao(ctx)).toEqual([]);
  });

  it("original cancelada → ORIGINAL_CANCELADA; rejeitada → ORIGINAL_NAO_AUTORIZADA", () => {
    const canc = ctxBase();
    canc.originais = [{ chaveAcesso: CHAVE, status: "CANCELLED", ambiente: "HOMOLOGACAO" }];
    expect(codigos(validarDevolucao(canc))).toEqual(["ORIGINAL_CANCELADA"]);
    const rej = ctxBase();
    rej.originais = [{ chaveAcesso: CHAVE, status: "REJECTED", ambiente: "HOMOLOGACAO" }];
    expect(codigos(validarDevolucao(rej))).toEqual(["ORIGINAL_NAO_AUTORIZADA"]);
  });

  it("original de outro ambiente → AMBIENTE_DIVERGENTE", () => {
    const ctx = ctxBase();
    ctx.originais = [{ chaveAcesso: CHAVE, status: "AUTHORIZED", ambiente: "PRODUCAO" }];
    expect(codigos(validarDevolucao(ctx))).toEqual(["AMBIENTE_DIVERGENTE"]);
  });
});

describe("validarDevolucao — tributação", () => {
  it("requerRevisao sem confirmação → TRIBUTACAO_REVISAO_PENDENTE; confirmada libera", () => {
    const ctx = ctxBase();
    ctx.refs[0].tributacao = { ...tribOk(), requerRevisao: true, motivosRevisao: ["IPI_DESTACADO"] };
    const i = achar(validarDevolucao(ctx), "TRIBUTACAO_REVISAO_PENDENTE")!;
    expect(i.mensagem).toMatch(/IPI/);
    ctx.refs[0].tributacao = { ...ctx.refs[0].tributacao!, confirmada: true };
    expect(validarDevolucao(ctx)).toEqual([]);
  });

  it("sem tributação → TRIBUTACAO_AUSENTE", () => {
    const ctx = ctxBase();
    ctx.refs[0].tributacao = null;
    expect(codigos(validarDevolucao(ctx))).toEqual(["TRIBUTACAO_AUSENTE"]);
  });

  it("grupo fora da allowlist confirmado ainda bloqueia → TRIBUTACAO_NAO_SUPORTADA", () => {
    const ctx = ctxBase();
    const t = tribOk();
    ctx.refs[0].tributacao = { ...t, icms: { ...t.icms, tag: null }, requerRevisao: true, confirmada: true, motivosRevisao: ["ICMS_GRUPO_NAO_SUPORTADO"] };
    expect(codigos(validarDevolucao(ctx))).toEqual(["TRIBUTACAO_NAO_SUPORTADA"]);
  });

  it("590/591: tag de família diferente do CRT do emitente → TRIBUTACAO_REGIME_INCOMPATIVEL", () => {
    const ctx = ctxBase();
    ctx.emitente.crt = "3";
    const i = achar(validarDevolucao(ctx), "TRIBUTACAO_REGIME_INCOMPATIVEL")!;
    expect(i.mensagem).toMatch(/590/);
  });

  it("impostoDevol com percentual fora de (0,100] → IPI_DEVOL_INVALIDO", () => {
    const ctx = ctxBase();
    ctx.refs[0].tributacao = { ...tribOk(), ipiDevol: { pDevol: 150, vIPIDevol: 1 } };
    expect(codigos(validarDevolucao(ctx))).toEqual(["IPI_DEVOL_INVALIDO"]);
  });

  it("avisos da tributação viram AVISO (PIS de saída numa entrada, IBS/CBS)", () => {
    const ctx = ctxBase();
    ctx.refs[0].tributacao = { ...tribOk(), avisos: ["PIS_CST_SAIDA_EM_ENTRADA", "IBS_CBS_NAO_ENVIADO"] };
    const issues = validarDevolucao(ctx);
    expect(codigos(issues)).toEqual(["PIS_CST_SAIDA_EM_ENTRADA", "IBS_CBS_NAO_ENVIADO"]);
    expect(temBloqueio(issues)).toBe(false);
  });

  // Decisão 4 do dono (onda 5): o 49 que a devolução de venda do Simples herda
  // das próprias vendas continua AVISO — mas o servidor avisa IGUAL ao campo da
  // tela (antes só a tela avisava: a derivação não marca o 49). É o rascunho
  // d93eb8c8 da DLS (nota 711): 102 + PIS/COFINS 49, avisos [] gravado.
  it("49 herdado numa devolução de venda → AVISO PIS_CST_SAIDA_EM_ENTRADA, sem bloquear (servidor = tela)", () => {
    const ctx = ctxBase();
    ctx.refs[0].tributacao = tribOk("49");
    expect(ctx.refs[0].tributacao.avisos).toEqual([]);
    const issues = validarDevolucao(ctx);
    expect(codigos(issues)).toEqual(["PIS_CST_SAIDA_EM_ENTRADA"]);
    expect(issues[0]).toMatchObject({ severidade: "AVISO", ordem: 1 });
    expect(issues[0].mensagem).toContain("49 do PIS e 49 da COFINS");
    expect(temBloqueio(issues)).toBe(false);
    // Marca gravada E código de saída: um aviso só por item.
    ctx.refs[0].tributacao = { ...tribOk("49"), avisos: ["PIS_CST_SAIDA_EM_ENTRADA"] };
    expect(codigos(validarDevolucao(ctx))).toEqual(["PIS_CST_SAIDA_EM_ENTRADA"]);
    // 98/99 numa entrada: nada.
    ctx.refs[0].tributacao = tribOk("98");
    expect(validarDevolucao(ctx)).toEqual([]);
  });
});

describe("validarDevolucao — origem da mercadoria", () => {
  // A devolução pela chave deixa a "Origem da mercadoria" em branco de propósito
  // (o Dexo não escolhe por ela). Em branco, o construtor escrevia `orig ?? 0`
  // — Nacional — sem avisar, e a SEFAZ autoriza: peça importada sairia errada.
  const comOrigem = (orig: number | null | undefined) => {
    const ctx = ctxBase();
    const t = ctx.refs[0].tributacao!;
    ctx.refs[0].tributacao = { ...t, icms: { ...t.icms, orig: orig as never } };
    return ctx;
  };

  it("origem ausente (null) é ERRO no item, e bloqueia a emissão", () => {
    const issues = validarDevolucao(comOrigem(null));
    const i = achar(issues, "ICMS_ORIGEM_NAO_INFORMADA");
    expect(i).toMatchObject({ severidade: "ERRO", ordem: 1 });
    expect(i!.mensagem).toContain("Item 1");
    expect(temBloqueio(issues)).toBe(true);
  });

  it("origem ausente (undefined) também é ERRO", () => {
    expect(codigos(validarDevolucao(comOrigem(undefined)))).toContain("ICMS_ORIGEM_NAO_INFORMADA");
  });

  it("origem 0 ESCOLHIDA (nacional) não é ausência: nenhuma pendência nova", () => {
    // O defeito seria confundir "não informou" com "informou 0". Zero é valor.
    expect(codigos(validarDevolucao(comOrigem(0)))).not.toContain("ICMS_ORIGEM_NAO_INFORMADA");
  });

  it("origem importada (1, 2, 6, 7) passa", () => {
    for (const o of [1, 2, 6, 7]) {
      expect(codigos(validarDevolucao(comOrigem(o)))).not.toContain("ICMS_ORIGEM_NAO_INFORMADA");
    }
  });
});
