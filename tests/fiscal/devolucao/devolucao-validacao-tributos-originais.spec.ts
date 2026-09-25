/**
 * `validarDevolucao` — as pendências novas da tributação (DLS AUTO PEÇAS, 24/09/2026).
 *
 * O que a caixinha "Revisei" NÃO pode mais liberar:
 *  - PIS/COFINS sem código, ou com código que o montador não emite;
 *  - 01/02 numa empresa do Simples, e 01/02 a alíquota zero;
 *  - ICMS-ST cobrado na nota original (o construtor ainda não devolve ST: a nota
 *    sairia AUTORIZADA sem ele, e o fornecedor sem como estornar);
 *  - regime da empresa não cadastrado (o montador carimbaria CRT 3).
 * E o que passa a AVISAR (sem bloquear): devolução de compra do Simples com
 * menos ICMS que a compra destacou (Res. CGSN 140/2018, art. 59), CSOSN 500
 * sem ST na compra, CST de entrada numa saída, cliente contribuinte na
 * devolução de venda. Mais um ERRO de cadastro: UF do fornecedor ≠ UF da chave.
 */
import { describe, expect, it } from "vitest";

import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import type { DevolucaoIssue, DevolucaoIssueCode, ImpostoOriginal, TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";
import { aplicarOverrideTributacao, normalizarImpostoOriginal, proporcionalizar } from "../../../app/fiscal/devolucao/tributacao";
import { temBloqueio, validarDevolucao, type ContextoValidacaoDevolucao } from "../../../app/fiscal/devolucao/validacao";
import { pendenciasDeIssues } from "../../../app/notas-fiscais/lib/nfe-devolucao-pendencias-ui";

const CNPJ_DLS = "57502966000144";
const CNPJ_DISAUTO = "80689839000975";

function chave(cnpj: string, cuf = "42", numero = 852899): string {
  const base = cuf + "2609" + cnpj + "55" + "001" + String(numero).padStart(9, "0") + "1" + "75799182";
  return base + calcularDvChaveAcesso(base)!;
}
const CHAVE_COMPRA = chave(CNPJ_DISAUTO);

const ITEM5 = normalizarImpostoOriginal({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "123.56", pICMS: "12.00", vICMS: "14.83" } },
  PIS: { PISAliq: { CST: "01", vBC: "108.73", pPIS: "1.65", vPIS: "1.79" } },
  COFINS: { COFINSAliq: { CST: "01", vBC: "108.73", pCOFINS: "7.60", vCOFINS: "8.26" } },
});

// O óleo LUBRAX da mesma nota: CST 10, ST de R$ 20,05 em 3 unidades.
const LUBRAX = normalizarImpostoOriginal({
  ICMS: { ICMS10: { orig: "0", CST: "10", modBC: "3", vBC: "117.45", pICMS: "12.00", vICMS: "14.09", vBCST: "200.87", vICMSST: "20.05" } },
  PIS: { PISNT: { CST: "04" } },
  COFINS: { COFINSNT: { CST: "04" } },
});

const baseCompra = (imposto: ImpostoOriginal, q = 1, qOrig = 1, vUn = 123.56) =>
  proporcionalizar({ impostoOriginal: imposto, qOriginal: qOrig, qDevolvida: q, vUnCom: vUn, crtEmitente: "1", crtOriginal: "3", tipoOperacao: "SAIDA" });

/** O ajuste que ela escolher (sempre confirmado: o que se prende aqui é o que a confirmação NÃO libera). */
function ajuste(base: TributacaoDevolucaoItem, override: Parameters<typeof aplicarOverrideTributacao>[0]["override"], baseItem = 123.56) {
  const r = aplicarOverrideTributacao({ base, override, confirmar: true, crtEmitente: "1", baseCalculoItem: baseItem, tipoOperacao: "SAIDA" });
  if (!r.ok) throw new Error("fixture inválida: " + r.erros.join("; "));
  return r.tributacao;
}

/** Devolução de COMPRA da DLS à DISAUTO, item 5, com CSOSN 900 a 12% e PIS/COFINS 49: o caso bom. */
function ctxCompra(): ContextoValidacaoDevolucao {
  const trib = ajuste(baseCompra(ITEM5), { icms: { csosn: "900", cst: null, pICMS: 12 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
  return {
    cabecalho: { tipo: "COMPRA_SAIDA", devolvidaAposEntrega: true, confirmadoSemXml: false, origensJson: [{ chaveAcesso: CHAVE_COMPRA, crtOriginal: "3" }] },
    nota: {
      modelo: "55", finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA", destinoOperacao: "INTERNA", ambiente: "PRODUCAO",
      destinatarioCpfCnpj: CNPJ_DISAUTO, destinatarioJson: { tipoPessoa: "PJ", inscricaoEstadual: "258272414", uf: "SC" },
      notasReferenciadasJson: null, pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }], duplicatasJson: null,
    },
    emitente: { cnpj: CNPJ_DLS, crt: "1" },
    itens: [{ numero: 1, codigo: "33603-3", quantidade: 1, cfop: "5202" }],
    refs: [{ ordem: 1, chaveAcesso: CHAVE_COMPRA, nItem: 5, codigoOriginal: "33603-3", quantidade: 1, quantidadeOriginal: 1, tributacao: trib, impostoOriginal: ITEM5 }],
    saldos: [{ chaveAcesso: CHAVE_COMPRA, nItem: 5, disponivel: 1 }],
    originais: [],
    idDestOriginal: 1,
  };
}

const codigos = (issues: DevolucaoIssue[]) => issues.map((i) => i.code);
const achar = (issues: DevolucaoIssue[], code: DevolucaoIssueCode) => issues.find((i) => i.code === code);

describe("o caso bom da DLS não ganha pendência nova", () => {
  it("CSOSN 900 a 12% (ICMS da compra) + PIS/COFINS 49, confirmado: emite sem nada", () => {
    expect(validarDevolucao(ctxCompra())).toEqual([]);
  });
});

describe("PIS/COFINS que a caixinha não libera", () => {
  it("sem código (manual sem XML, ou 03 na original) → PIS_COFINS_NAO_SUPORTADO, mesmo confirmado", () => {
    const ctx = ctxCompra();
    const t = ctx.refs[0].tributacao!;
    ctx.refs[0].tributacao = { ...t, pis: { cst: null, vBC: 0, p: 0, v: 0 }, cofins: { cst: null, vBC: 0, p: 0, v: 0 }, confirmada: true };
    ctx.refs[0].impostoOriginal = normalizarImpostoOriginal({
      ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "123.56", pICMS: "12.00", vICMS: "14.83" } },
      PIS: { PISQtde: { CST: "03", qBCProd: "1", vAliqProd: "0.5", vPIS: "0.5" } },
      COFINS: { COFINSOutr: { CST: "99", qBCProd: "1", vAliqProd: "2", vCOFINS: "2" } },
    });
    const issues = validarDevolucao(ctx);
    const i = achar(issues, "PIS_COFINS_NAO_SUPORTADO")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.ordem).toBe(1);
    expect(i.mensagem).toContain("do PIS e da COFINS");
    expect(i.mensagem).toContain("PIS 03 por quantidade");
    expect(i.mensagem).toContain("COFINS 99 por quantidade");
    expect(i.mensagem).toContain("não escolhe por você");
    expect(temBloqueio(issues)).toBe(true);
  });

  it("01 numa empresa do Simples → PIS_COFINS_REGIME_INCOMPATIVEL; no regime normal, não", () => {
    const ctx = ctxCompra();
    const t = ctx.refs[0].tributacao!;
    ctx.refs[0].tributacao = { ...t, pis: { cst: "01", vBC: 108.73, p: 1.65, v: 1.79 } };
    const i = achar(validarDevolucao(ctx), "PIS_COFINS_REGIME_INCOMPATIVEL")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).toContain("01 do PIS");
    expect(i.mensagem).toContain("Simples Nacional");
    ctx.emitente.crt = "3";
    expect(codigos(validarDevolucao(ctx))).not.toContain("PIS_COFINS_REGIME_INCOMPATIVEL");
  });

  it("01 a alíquota zero (regime normal) → PIS_COFINS_ALIQUOTA_INVALIDA; com alíquota, passa", () => {
    const ctx = ctxCompra();
    ctx.emitente.crt = "3";
    const t = ctx.refs[0].tributacao!;
    ctx.refs[0].tributacao = { ...t, icms: { tag: "ICMS00", cst: "00", csosn: null, orig: 0, modBC: "3", vBC: 123.56, pICMS: 12, vICMS: 14.83 }, cofins: { cst: "01", vBC: 0, p: 0, v: 0 } };
    const i = achar(validarDevolucao(ctx), "PIS_COFINS_ALIQUOTA_INVALIDA")!;
    expect(i.mensagem).toContain("COFINS com CST 01");
    expect(i.mensagem).toContain("06");
    ctx.refs[0].tributacao = { ...ctx.refs[0].tributacao!, cofins: { cst: "01", vBC: 108.73, p: 7.6, v: 8.26 } };
    expect(codigos(validarDevolucao(ctx))).not.toContain("PIS_COFINS_ALIQUOTA_INVALIDA");
  });

  it("CST de entrada numa nota de saída → AVISO PIS_CST_ENTRADA_EM_SAIDA (não bloqueia)", () => {
    const ctx = ctxCompra();
    const t = ctx.refs[0].tributacao!;
    ctx.refs[0].tributacao = { ...t, cofins: { cst: "98", vBC: 0, p: 0, v: 0 } };
    const issues = validarDevolucao(ctx);
    expect(codigos(issues)).toEqual(["PIS_CST_ENTRADA_EM_SAIDA"]);
    expect(issues[0].severidade).toBe("AVISO");
    expect(issues[0].mensagem).toContain("98 da COFINS");
    expect(temBloqueio(issues)).toBe(false);
  });
});

describe("ICMS-ST da nota original: ERRO que a caixinha não libera", () => {
  it("o LUBRAX (1 de 3 unidades): diz os R$ 6,68 de ST que ficariam de fora", () => {
    const ctx = ctxCompra();
    const base = baseCompra(LUBRAX, 1, 3, 39.15);
    ctx.refs[0] = {
      ...ctx.refs[0], nItem: 1, quantidade: 1, quantidadeOriginal: 3, impostoOriginal: LUBRAX,
      tributacao: ajuste(base, { icms: { csosn: "900", cst: null, pICMS: 12 }, pis: { cst: "04" }, cofins: { cst: "04" } }, 39.15),
    };
    ctx.saldos = [{ chaveAcesso: CHAVE_COMPRA, nItem: 1, disponivel: 3 }];
    expect(ctx.refs[0].tributacao!.confirmada).toBe(true);
    const issues = validarDevolucao(ctx);
    const i = achar(issues, "ICMS_ST_NAO_DEVOLVIDO")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).toContain("R$ 6,68");
    expect(i.mensagem).toContain("na quantidade devolvida");
    expect(i.mensagem).toContain("contadora");
    expect(temBloqueio(issues)).toBe(true);
  });

  it("sem o imposto original no contexto, o motivo gravado basta para bloquear", () => {
    const ctx = ctxCompra();
    const t = ctx.refs[0].tributacao!;
    ctx.refs[0] = { ...ctx.refs[0], impostoOriginal: undefined, tributacao: { ...t, motivosRevisao: [...t.motivosRevisao, "ICMS_ST_NAO_SUPORTADO"] } };
    const i = achar(validarDevolucao(ctx), "ICMS_ST_NAO_DEVOLVIDO")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).not.toContain("R$");
  });
});

describe("devolução de compra do Simples com ICMS a menos (Res. CGSN 140/2018, art. 59)", () => {
  it("o rascunho 8d269885: CSOSN 900 a 0% → AVISO com os R$ 14,83 que ficam de fora", () => {
    const ctx = ctxCompra();
    ctx.refs[0].tributacao = ajuste(baseCompra(ITEM5), { icms: { csosn: "900", cst: null, pICMS: 0 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    const issues = validarDevolucao(ctx);
    expect(codigos(issues)).toEqual(["ICMS_COMPRA_A_MENOR"]);
    const i = issues[0];
    expect(i.severidade).toBe("AVISO");
    expect(i.mensagem).toContain("R$ 14,83");
    expect(i.mensagem).toContain("ficam de fora R$ 14,83");
    expect(i.mensagem).toContain("Res. CGSN 140/2018, art. 59");
    expect(i.mensagem).toContain("contadora");
    expect(temBloqueio(issues)).toBe(false);
  });

  it("102 (sem valor) também avisa; 900 a 12% (o da compra) não; 1 centavo de arredondamento não", () => {
    const ctx = ctxCompra();
    ctx.refs[0].tributacao = ajuste(baseCompra(ITEM5), { icms: { csosn: "102", cst: null }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    expect(codigos(validarDevolucao(ctx))).toEqual(["ICMS_COMPRA_A_MENOR"]);
    const ok = ctxCompra();
    expect(codigos(validarDevolucao(ok))).not.toContain("ICMS_COMPRA_A_MENOR");
    const t = ok.refs[0].tributacao!;
    ok.refs[0].tributacao = { ...t, icms: { ...t.icms, vICMS: 14.82 } };
    expect(codigos(validarDevolucao(ok))).not.toContain("ICMS_COMPRA_A_MENOR");
    ok.refs[0].tributacao = { ...t, icms: { ...t.icms, vICMS: 14.81 } };
    expect(codigos(validarDevolucao(ok))).toContain("ICMS_COMPRA_A_MENOR");
  });

  it("não avisa: fornecedor também do Simples, emitente do regime normal, ou devolução de venda", () => {
    const sn = ctxCompra();
    sn.cabecalho!.origensJson = [{ chaveAcesso: CHAVE_COMPRA, crtOriginal: "1" }];
    sn.refs[0].tributacao = ajuste(baseCompra(ITEM5), { icms: { csosn: "102", cst: null }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    expect(codigos(validarDevolucao(sn))).not.toContain("ICMS_COMPRA_A_MENOR");

    const venda = ctxCompra();
    venda.cabecalho!.tipo = "VENDA_ENTRADA";
    venda.refs[0].tributacao = ajuste(baseCompra(ITEM5), { icms: { csosn: "102", cst: null }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    expect(codigos(validarDevolucao(venda))).not.toContain("ICMS_COMPRA_A_MENOR");
  });

  it("sem crtOriginal no contexto, o tipo do código da compra (CST) decide", () => {
    const ctx = ctxCompra();
    ctx.cabecalho!.origensJson = undefined;
    ctx.refs[0].tributacao = ajuste(baseCompra(ITEM5), { icms: { csosn: "102", cst: null }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    expect(codigos(validarDevolucao(ctx))).toContain("ICMS_COMPRA_A_MENOR");
  });

  it("CSOSN 500 num item cuja compra NÃO teve ST → AVISO ICMS_500_SEM_ST; com ST retido (CST 60), não", () => {
    const ctx = ctxCompra();
    ctx.refs[0].tributacao = ajuste(baseCompra(ITEM5), { icms: { csosn: "500", cst: null }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    const issues = validarDevolucao(ctx);
    const i = achar(issues, "ICMS_500_SEM_ST")!;
    expect(i.severidade).toBe("AVISO");
    expect(i.mensagem).toContain("não teve ST");
    expect(i.mensagem).toContain("código 00");
    expect(temBloqueio(issues)).toBe(false);

    const retido = normalizarImpostoOriginal({ ICMS: { ICMS60: { orig: "0", CST: "60" } }, PIS: { PISNT: { CST: "04" } }, COFINS: { COFINSNT: { CST: "04" } } });
    ctx.refs[0].impostoOriginal = retido;
    expect(codigos(validarDevolucao(ctx))).not.toContain("ICMS_500_SEM_ST");
  });
});

describe("cabeçalho e cadastro", () => {
  it("regime não cadastrado (crt null) → REGIME_NAO_CADASTRADO; crt ausente não é avaliado", () => {
    const ctx = ctxCompra();
    ctx.emitente.crt = null;
    const i = achar(validarDevolucao(ctx), "REGIME_NAO_CADASTRADO")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).toMatch(/590/);
    ctx.emitente = { cnpj: CNPJ_DLS };
    expect(codigos(validarDevolucao(ctx))).not.toContain("REGIME_NAO_CADASTRADO");
  });

  it("devolução de venda a cliente com IE → AVISO DESTINATARIO_CONTRIBUINTE (mesma regra do indIEDest)", () => {
    const venda = (dest: ContextoValidacaoDevolucao["nota"]["destinatarioJson"]) => {
      const ctx = ctxCompra();
      ctx.cabecalho!.tipo = "VENDA_ENTRADA";
      ctx.nota.tipoOperacao = "ENTRADA";
      ctx.nota.destinatarioJson = dest;
      return codigos(validarDevolucao(ctx));
    };
    expect(venda({ tipoPessoa: "PJ", inscricaoEstadual: "123456789" })).toContain("DESTINATARIO_CONTRIBUINTE");
    expect(venda({ tipoPessoa: "PJ", inscricaoEstadual: "ISENTO" })).not.toContain("DESTINATARIO_CONTRIBUINTE");
    expect(venda({ tipoPessoa: "PF", inscricaoEstadual: null })).not.toContain("DESTINATARIO_CONTRIBUINTE");
    expect(venda({ tipoPessoa: "EXTERIOR", inscricaoEstadual: "123" })).not.toContain("DESTINATARIO_CONTRIBUINTE");
    // Na devolução de COMPRA o destinatário é o fornecedor: sempre contribuinte, sem aviso.
    expect(codigos(validarDevolucao(ctxCompra()))).not.toContain("DESTINATARIO_CONTRIBUINTE");
  });

  it("devolução de compra com a UF do destinatário ≠ UF da chave → DESTINATARIO_UF_DIVERGENTE_CHAVE", () => {
    const ctx = ctxCompra();
    ctx.nota.destinatarioJson = { tipoPessoa: "PJ", inscricaoEstadual: "1", uf: "PR" };
    const i = achar(validarDevolucao(ctx), "DESTINATARIO_UF_DIVERGENTE_CHAVE")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).toContain("SC");
    expect(i.mensagem).toContain("UF PR");
    ctx.nota.destinatarioJson = { tipoPessoa: "PJ", inscricaoEstadual: "1", uf: "sc" };
    expect(codigos(validarDevolucao(ctx))).not.toContain("DESTINATARIO_UF_DIVERGENTE_CHAVE");
  });
});

describe("toda pendência nova tem texto na tela (título e caminho)", () => {
  const NOVAS: DevolucaoIssueCode[] = [
    "REGIME_NAO_CADASTRADO", "DESTINATARIO_CONTRIBUINTE", "DESTINATARIO_UF_DIVERGENTE_CHAVE",
    "PIS_COFINS_NAO_SUPORTADO", "PIS_COFINS_REGIME_INCOMPATIVEL", "PIS_COFINS_ALIQUOTA_INVALIDA",
    "PIS_CST_ENTRADA_EM_SAIDA", "ICMS_ST_NAO_DEVOLVIDO", "ICMS_COMPRA_A_MENOR", "ICMS_500_SEM_ST",
  ];
  it.each(NOVAS)("%s", (code) => {
    const [p] = pendenciasDeIssues([{ code, severidade: "ERRO", ordem: 2, mensagem: `Item 2: detalhe de ${code}.` }]);
    expect(p.codigo).toBe(code);
    // Código conhecido: o título vem do catálogo, não da mensagem crua do servidor.
    expect(p.titulo).not.toContain("detalhe de");
    expect(p.titulo.length).toBeGreaterThan(15);
    expect(p.comoResolver.length).toBeGreaterThan(20);
    // Fala com a dona do desmanche: nada de jargão de sistema.
    for (const jargao of ["escopo", "gerenciada", "issue", "payload"]) {
      expect(`${p.titulo} ${p.comoResolver}`.toLowerCase()).not.toContain(jargao);
    }
  });

  it("o ST cita a caixinha pelo rótulo exato e diz que ela não libera", () => {
    const [p] = pendenciasDeIssues([{ code: "ICMS_ST_NAO_DEVOLVIDO", severidade: "ERRO", ordem: 1, mensagem: "Item 1: x" }]);
    expect(p.titulo).toBe("A nota original cobrou ICMS-ST, e o Dexo ainda não devolve ICMS-ST no item 1");
    expect(p.comoResolver).toContain('"Revisei a tributação deste item" não libera');
  });
});

describe("IPI devolvido fora de 0–100: a frase aponta o que ela controla (N-pis-cofins-ipi-5)", () => {
  it("o percentual sai da quantidade — a mensagem manda conferir a quantidade no passo 3, não um campo que não existe", () => {
    const ctx = ctxCompra();
    ctx.refs[0].tributacao = { ...ctx.refs[0].tributacao!, ipiDevol: { pDevol: 150, vIPIDevol: 1 } };
    const i = achar(validarDevolucao(ctx), "IPI_DEVOL_INVALIDO")!;
    expect(i.severidade).toBe("ERRO");
    expect(i.mensagem).toContain("sai da quantidade devolvida");
    expect(i.mensagem).toContain('passo 3 ("Produtos")');
  });
});
