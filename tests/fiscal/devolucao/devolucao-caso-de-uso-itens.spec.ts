/**
 * PUT /fiscal/nfe/draft/:id/devolucao/itens, GET do detalhe e PUT do cabeçalho pelo
 * caso de uso — com a devolução de COMPRA da DLS AUTO PEÇAS (Simples) à DISAUTO
 * (regime normal), itens 5 e 6 da NF-e 852899.
 *
 * O que cada bloco prende (achados da auditoria de 24/09/2026):
 * - K1/N-icms-residual-4: a recusa de tributação chegava muda ("Tributação não suportada
 *   na devolução.") — o motivo de cada tributo de CADA item, na ordem que a tela mostra.
 * - N-saldo-ledger-1/N-fluxo-2: com "Escopo: Total", devolver MENOS peças voltava
 *   "Quantidade maior que o saldo" (rascunho 36730421, três vezes). O escopo é derivado.
 * - N-saldo-ledger-3: recusa de saldo e de CFOP sem item nem número.
 * - N-pis-cofins-ipi-1/N-icms-residual-2: campo ausente do corpo = o GRAVADO, não o do XML.
 * - G1 (pendente para o caso de uso): base líquida do desconto e base do ICMS da original.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aplicarOverrideTributacao, normalizarImpostoOriginal, proporcionalizar } from "../../../app/fiscal/devolucao/tributacao";
import { mesclarAjusteTributacao } from "../../../app/usecases/nfe-devolucao.usecase";
import { CFC, CHAVE_DISAUTO, casoDeUso, configDls, erroDe, linha, repoEmMemoria, stubFlags } from "./devolucao-caso-de-uso-fixtures";

beforeEach(stubFlags);
afterEach(() => { vi.unstubAllEnvs(); });

const ICMS00_01 = (vBC: number) => ({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: vBC.toFixed(2), pICMS: "12.00", vICMS: (vBC * 0.12).toFixed(2) } },
  PIS: { PISAliq: { CST: "01", vBC: vBC.toFixed(2), pPIS: "1.65", vPIS: (vBC * 0.0165).toFixed(2) } },
  COFINS: { COFINSAliq: { CST: "01", vBC: vBC.toFixed(2), pCOFINS: "7.60", vCOFINS: (vBC * 0.076).toFixed(2) } },
});

interface ItemFixture { nItem: number; codigo: string; vUn: number; imposto: unknown; qCom?: number; vDesc?: number; origem?: number | null }
const ITEM5: ItemFixture = { nItem: 5, codigo: "33603-3", vUn: 123.56, imposto: ICMS00_01(123.56) };
const ITEM6: ItemFixture = { nItem: 6, codigo: "24171-7", vUn: 295.88, imposto: ICMS00_01(295.88) };

function snapshot(i: ItemFixture, fonte: string) {
  const q = i.qCom ?? 1;
  return {
    nItem: i.nItem, codigo: i.codigo, descricao: "PECA " + i.codigo, ncm: "84133090", cest: null, unidade: "UN", cfop: "5102",
    quantidade: fonte === "MANUAL" ? 0 : q, valorUnitario: i.vUn, valorProduto: i.vUn * q, desconto: i.vDesc ?? 0,
    origem: i.origem === undefined ? 0 : i.origem, impostoOriginal: normalizarImpostoOriginal(fonte === "MANUAL" ? null : i.imposto),
  };
}

function persistida(o: {
  itens?: ItemFixture[]; salvos?: number[]; tipo?: string; fonte?: string; escopo?: string; crtOriginal?: string;
  tributacaoSalva?: Record<number, unknown>; crtEmitente?: string;
} = {}) {
  const itens = o.itens ?? [ITEM5, ITEM6];
  const fonte = o.fonte ?? "XML_IMPORTADO";
  const tipo = o.tipo ?? "COMPRA_SAIDA";
  const snap = itens.map((i) => snapshot(i, fonte));
  const salvos = o.salvos ?? itens.map((i) => i.nItem);
  const refs = salvos.map((nItem, k) => {
    const s = snap.find((x) => x.nItem === nItem)!;
    const base = proporcionalizar({
      impostoOriginal: fonte === "MANUAL" ? null : s.impostoOriginal, qOriginal: s.quantidade || null, qDevolvida: 1, vUnCom: s.valorUnitario,
      crtEmitente: o.crtEmitente ?? "1", crtOriginal: o.crtOriginal ?? "3", tipoOperacao: tipo === "COMPRA_SAIDA" ? "SAIDA" : "ENTRADA",
    });
    return {
      ordem: k + 1, originalNfeId: null, chaveAcessoOriginal: CHAVE_DISAUTO, nItemOriginal: nItem, codigoOriginal: s.codigo, cfopOriginal: "5102",
      quantidadeOriginal: s.quantidade || null, valorUnitarioOriginal: s.valorUnitario, quantidade: 1, valor: s.valorUnitario,
      impostoOriginal: fonte === "MANUAL" ? null : s.impostoOriginal, tributacao: o.tributacaoSalva?.[nItem] ?? base,
      cfopMapeamento: { status: "MAPEADO", opcoes: ["5202"], cfop: "5202" },
    };
  });
  return {
    cabecalho: {
      nfeId: "dev-dls", userId: "tenant", tipo, fonte, escopoSolicitado: o.escopo ?? "PARCIAL", devolvidaAposEntrega: true,
      confirmadoSemXml: fonte === "MANUAL", indFinal: "0", updatedAt: new Date(),
      origensJson: [{ originalNfeId: null, chaveAcesso: CHAVE_DISAUTO, modelo: "55", numero: 852899, serie: 1, dataEmissao: "2026-09-10", idDest: 1, crtOriginal: o.crtOriginal ?? "3", emitenteCnpjCpf: "80689839000975", itens: snap }],
    },
    refs,
    nota: {
      id: "dev-dls", userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", serie: 1, numero: -40, status: "DRAFT", ambiente: "HOMOLOGACAO",
      finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA", destinoOperacao: "INTERNA", valorFrete: null,
      destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: "80689839000975", nome: "DISAUTO", uf: "SC", inscricaoEstadual: "258272414" },
      pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }], duplicatasJson: null, notasReferenciadasJson: null,
      itens: refs.map((r) => ({ numero: r.ordem, codigo: r.codigoOriginal, descricao: "PECA", ncm: "84133090", unidade: "UN", cfop: "5202", quantidade: 1, valorUnitario: r.valor, valorTotal: r.valor, desconto: 0 })),
    },
  };
}

function montar(o: Parameters<typeof persistida>[0] & { linhas?: ReturnType<typeof linha>[]; config?: ReturnType<typeof configDls> } = {}) {
  const dados = persistida(o);
  const { repo, chamadas } = repoEmMemoria({ persistidas: { "dev-dls": dados }, linhas: o.linhas });
  const uc = casoDeUso(repo, o.config ?? configDls());
  // O fim de itens()/cabecalho() relê o detalhe inteiro; aqui importa o que foi GRAVADO.
  const salvar = (itens: Array<Record<string, unknown>>) => {
    (uc as unknown as { detalhe: () => Promise<null> }).detalhe = async () => null;
    return uc.itens("tenant", "tenant", "dev-dls", { itens: itens.map((i) => ({ chaveAcesso: CHAVE_DISAUTO, quantidade: 1, cfop: "5202", ...i })) } as never);
  };
  return { uc, salvar, chamadas, dados };
}

describe("K1: a recusa da tributação diz o item, o tributo e o motivo — de TODOS os itens", () => {
  it("PIS/COFINS 01 numa empresa do Simples, nos dois itens: 422 com as 4 recusas, e nada é gravado", async () => {
    const { salvar, chamadas } = montar();
    const pis01 = { pis: { cst: "01", p: 1.65 }, cofins: { cst: "01", p: 7.6 } };
    const e = await erroDe(salvar([{ nItem: 5, tributacao: pis01 }, { nItem: 6, tributacao: pis01 }]));
    expect(e.code).toBe("TRIBUTACAO_NAO_SUPORTADA");
    expect(e.httpStatus).toBe(422);
    expect(e.issues.map((i: any) => [i.ordem, i.code])).toEqual([
      [1, "PIS_COFINS_REGIME_INCOMPATIVEL"], [1, "PIS_COFINS_REGIME_INCOMPATIVEL"],
      [2, "PIS_COFINS_REGIME_INCOMPATIVEL"], [2, "PIS_COFINS_REGIME_INCOMPATIVEL"],
    ]);
    expect(e.issues[0].severidade).toBe("ERRO");
    expect(e.issues[0].mensagem).toMatch(/^Item 1: PIS: O CST 01 é de empresa do regime normal/);
    expect(e.issues[3].mensagem).toMatch(/^Item 2: COFINS: /);
    expect(chamadas.gravados).toHaveLength(0);
  });

  it("a ordem é a da TELA (a gravada), não a posição na lista nova: só o item 6 no corpo continua 'Item 2'", async () => {
    const { salvar } = montar();
    const e = await erroDe(salvar([{ nItem: 6, tributacao: { pis: { cst: "01", p: 1.65 } } }]));
    expect(e.issues).toHaveLength(1);
    expect(e.issues[0]).toMatchObject({ ordem: 2, code: "PIS_COFINS_REGIME_INCOMPATIVEL" });
    expect(e.issues[0].mensagem).toMatch(/^Item 2: PIS: /);
  });

  it("ICMS de outro regime (CST 90 escolhido no Simples): TRIBUTACAO_REGIME_INCOMPATIVEL com o motivo", async () => {
    const { salvar } = montar({ tributacaoSalva: {} });
    const e = await erroDe(salvar([{ nItem: 5, tributacao: { icms: { cst: "90", pICMS: 12 } } }]));
    expect(e.issues[0]).toMatchObject({ ordem: 1, code: "TRIBUTACAO_REGIME_INCOMPATIVEL" });
    expect(e.issues[0].mensagem).toMatch(/^Item 1: ICMS: 90 é CST, de empresa do regime normal/);
  });
});

describe("N-saldo-ledger-1/N-fluxo-2: o escopo é DERIVADO dos itens, e 'Total' não trava mais a edição", () => {
  it("rascunho marcado Total, devolvendo só o item 6: grava (antes: 409 'Quantidade maior que o saldo') e o escopo vira PARCIAL", async () => {
    const { salvar, chamadas } = montar({ escopo: "TOTAL" });
    await salvar([{ nItem: 6 }]);
    expect(chamadas.gravados).toHaveLength(1);
    expect(chamadas.gravados[0].refs.map((r: any) => r.nItemOriginal)).toEqual([6]);
    expect(chamadas.gravados[0].escopo).toBe("PARCIAL");
  });

  it("todas as peças da nota com a quantidade cheia: o escopo vira TOTAL", async () => {
    const { salvar, chamadas } = montar({ escopo: "PARCIAL" });
    await salvar([{ nItem: 5 }, { nItem: 6 }]);
    expect(chamadas.gravados[0].escopo).toBe("TOTAL");
  });

  it("peça que OUTRA devolução já devolveu em parte: devolver o resto é PARCIAL (a nota não volta inteira aqui)", async () => {
    const { salvar, chamadas } = montar({ itens: [{ ...ITEM5, qCom: 2 }, ITEM6], linhas: [linha(5, 1, "AUTHORIZED")] });
    await salvar([{ nItem: 5, quantidade: 1 }, { nItem: 6 }]);
    expect(chamadas.gravados[0].escopo).toBe("PARCIAL");
  });

  it("pela chave (sem quantidade original), marcado Total: salvar sem mudar nada grava — antes recusava SEMPRE", async () => {
    const { salvar, chamadas } = montar({ fonte: "MANUAL", escopo: "TOTAL", itens: [ITEM6] });
    await salvar([{ nItem: 6 }]);
    expect(chamadas.gravados).toHaveLength(1);
    expect(chamadas.gravados[0].escopo).toBe("PARCIAL");
  });

  it("PUT do cabeçalho com escopo 'TOTAL' sobre uma lista parcial: grava o DERIVADO (PARCIAL), não o pedido", async () => {
    const { uc, chamadas } = montar({ salvos: [6] });
    (uc as unknown as { detalhe: () => Promise<null> }).detalhe = async () => null;
    await uc.cabecalho("tenant", "tenant", "dev-dls", { escopo: "TOTAL", devolvidaAposEntrega: true });
    const update = chamadas.sql.find((s) => s.sql.includes(`UPDATE "NfeDevolucao"`))!;
    expect(update.args[4]).toBe("PARCIAL");
    expect(update.args[3]).toBe(true);
  });
});

describe("N-saldo-ledger-3: recusa de saldo e de CFOP diz o item e o número", () => {
  it("peça que outra devolução JÁ devolveu: SALDO_INSUFICIENTE com 'não tem mais saldo' e onde está", async () => {
    const { salvar, chamadas } = montar({ linhas: [linha(6, 1, "AUTHORIZED")] });
    const e = await erroDe(salvar([{ nItem: 5 }, { nItem: 6 }]));
    expect(e.code).toBe("SALDO_INSUFICIENTE");
    // + nItem/chaveAcesso (revisão de regressão, G2 #2): a issue diz a PEÇA, não só a ordem.
    expect(e.issues).toEqual([{
      code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: 2, nItem: 6, chaveAcesso: CHAVE_DISAUTO,
      mensagem: "Item 2: 24171-7 (item 6 da nota original): este item não tem mais saldo para devolver (1 já devolvido em NF-e autorizada). Tire o item desta devolução.",
    }]);
    expect(chamadas.gravados).toHaveLength(0);
  });

  it("CFOP que não é de devolução: CFOP_INVALIDO com o item e o CFOP", async () => {
    const { salvar } = montar();
    const e = await erroDe(salvar([{ nItem: 5 }, { nItem: 6, cfop: "5102" }]));
    expect(e.code).toBe("CFOP_INVALIDO");
    // + nItem/chaveAcesso (revisão de regressão, G2 #2): a issue diz a PEÇA, não só a ordem.
    expect(e.issues).toEqual([{ code: "CFOP_NAO_DEVOLUCAO", severidade: "ERRO", ordem: 2, nItem: 6, chaveAcesso: CHAVE_DISAUTO, mensagem: "Item 2: o CFOP 5102 não é de devolução para esta operação (Rejeição 327)." }]);
  });

  it("CFOP de outro destino (6202 numa devolução dentro do estado): CFOP_IDDEST_DIVERGENTE", async () => {
    const { salvar } = montar();
    const e = await erroDe(salvar([{ nItem: 5, cfop: "6202" }]));
    expect(e.issues[0]).toMatchObject({ code: "CFOP_IDDEST_DIVERGENTE", ordem: 1 });
    expect(e.issues[0].mensagem).toBe("Item 1: o CFOP 6202 não combina com o destino da operação, que é dentro do estado.");
  });

  it("os mesmos CFOPs de antes continuam aceitos (5202 dentro do estado)", async () => {
    const { salvar, chamadas } = montar();
    await salvar([{ nItem: 5, cfop: "5202" }, { nItem: 6, cfop: "5202" }]);
    expect(chamadas.gravados).toHaveLength(1);
  });

  it("problemas de itens diferentes voltam JUNTOS (antes: um por vez)", async () => {
    const { salvar } = montar();
    const e = await erroDe(salvar([{ nItem: 5, cfop: "5102" }, { nItem: 6, tributacao: { pis: { cst: "01", p: 1.65 } } }]));
    expect(e.code).toBe("CFOP_INVALIDO");
    expect(e.issues.map((i: any) => [i.ordem, i.code])).toEqual([[1, "CFOP_NAO_DEVOLUCAO"], [2, "PIS_COFINS_REGIME_INCOMPATIVEL"]]);
  });
});

/** O ajuste que ela gravou num item: override aplicado sobre a base do XML. */
function salvoCom(item: ItemFixture, override: Record<string, unknown>, crt = "1") {
  const base = proporcionalizar({ impostoOriginal: normalizarImpostoOriginal(item.imposto), qOriginal: 1, qDevolvida: 1, vUnCom: item.vUn, crtEmitente: crt, crtOriginal: "3", tipoOperacao: "SAIDA" });
  const r = aplicarOverrideTributacao({ base, override: override as never, confirmar: false, crtEmitente: crt, baseCalculoItem: item.vUn, tipoOperacao: "SAIDA" });
  if (!r.ok) throw new Error("fixture: " + r.erros.join("; "));
  return r.tributacao;
}

describe("N-pis-cofins-ipi-1: campo ausente do corpo = o valor GRAVADO (o que a tela mostra), nunca o do XML", () => {
  it("900 gravado a 0%; escolher de novo o 900 sem digitar alíquota mantém 0% (antes voltava aos 12% da DISAUTO)", async () => {
    const t = salvoCom(ITEM6, { icms: { csosn: "900", cst: null, pICMS: 0 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    const { salvar, chamadas } = montar({ tributacaoSalva: { 6: t } });
    await salvar([{ nItem: 5 }, { nItem: 6, tributacao: { icms: { csosn: "900", cst: null } } }]);
    const g = chamadas.gravados[0].refs.find((r: any) => r.nItemOriginal === 6).tributacao;
    expect(g.icms).toMatchObject({ tag: "ICMSSN900", csosn: "900", pICMS: 0, vICMS: 0 });
  });

  it("PIS 01 a 1,65% gravado (regime normal) num item cujo XML é 04; reenviar só o CST mantém 1,65% (produção, 18:24)", async () => {
    const ITEM_04: ItemFixture = { ...ITEM6, imposto: { ...(ITEM6.imposto as object), PIS: { PISNT: { CST: "04" } }, COFINS: { COFINSNT: { CST: "04" } } } };
    const t = salvoCom(ITEM_04, { pis: { cst: "01", p: 1.65 } }, "3");
    const { salvar, chamadas } = montar({ itens: [ITEM_04], tributacaoSalva: { 6: t }, crtEmitente: "3", config: configDls({ regimeTributario: "LUCRO_PRESUMIDO" }) });
    await salvar([{ nItem: 6, tributacao: { pis: { cst: "01" } } }]);
    const g = chamadas.gravados[0].refs[0].tributacao;
    expect(g.pis).toMatchObject({ cst: "01", p: 1.65 });
    expect(g.pis.v).toBeGreaterThan(0);
  });

  it("o par cst/csosn do ICMS é atômico: CSOSN novo não deixa o CST antigo junto", () => {
    const m = mesclarAjusteTributacao({ icms: { cst: "00", csosn: null, modBC: "3", pICMS: 12 } }, { icms: { csosn: "900" } });
    expect(m?.icms).toEqual({ cst: null, csosn: "900", modBC: "3", pICMS: 12 });
  });

  it("tributo ausente do corpo fica o salvo inteiro; o que vem substitui só o campo que vem", () => {
    const salvo = { icms: { cst: null, csosn: "900", modBC: "3", pICMS: 0 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } };
    expect(mesclarAjusteTributacao(salvo, { pis: { p: 0 } })).toEqual({ ...salvo, pis: { cst: "49", p: 0 } });
    expect(mesclarAjusteTributacao(salvo, undefined)).toBe(salvo);
    expect(mesclarAjusteTributacao(undefined, { pis: { cst: "49" } })).toEqual({ pis: { cst: "49" } });
  });
});

describe("base do ajuste (pendência do G1 para o caso de uso)", () => {
  it("a base que nasce do item é LÍQUIDA do desconto: vProd 100, desconto 10, 900 a 12% ⇒ base 90, ICMS 10,80", async () => {
    const ITEM_40: ItemFixture = { nItem: 6, codigo: "24171-7", vUn: 100, vDesc: 10, imposto: { ICMS: { ICMS40: { orig: "0", CST: "40" } }, PIS: { PISNT: { CST: "04" } }, COFINS: { COFINSNT: { CST: "04" } } } };
    const { salvar, chamadas } = montar({ itens: [ITEM_40] });
    await salvar([{ nItem: 6, tributacao: { icms: { csosn: "900", cst: null, pICMS: 12 } } }]);
    const g = chamadas.gravados[0];
    expect(g.refs[0].tributacao.icms).toMatchObject({ tag: "ICMSSN900", vBC: 90, pICMS: 12, vICMS: 10.8 });
    expect(g.itens[0].desconto).toBe(10);
  });

  it("CST 20 (base reduzida) na original: a base do ICMS escolhido é a da nota original (60), não o valor cheio (100)", async () => {
    const ITEM_20: ItemFixture = { nItem: 6, codigo: "24171-7", vUn: 100, imposto: { ICMS: { ICMS20: { orig: "0", CST: "20", modBC: "3", pRedBC: "40.00", vBC: "60.00", pICMS: "12.00", vICMS: "7.20" } }, PIS: { PISNT: { CST: "04" } }, COFINS: { COFINSNT: { CST: "04" } } } };
    const { salvar, chamadas } = montar({ itens: [ITEM_20], crtEmitente: "3", config: configDls({ regimeTributario: "LUCRO_PRESUMIDO" }) });
    await salvar([{ nItem: 6, tributacao: { icms: { cst: "00", pICMS: 12 } } }]);
    expect(chamadas.gravados[0].refs[0].tributacao.icms).toMatchObject({ tag: "ICMS00", vBC: 60, vICMS: 7.2 });
  });

  it("pela chave: a origem da mercadoria gravada na nota original chega ao ICMS em todo save (antes: null ⇒ <orig>0</orig>)", async () => {
    const { salvar, chamadas } = montar({ fonte: "MANUAL", itens: [{ ...ITEM6, origem: 5 }] });
    await salvar([{ nItem: 6 }]);
    expect(chamadas.gravados[0].refs[0].tributacao.icms.orig).toBe(5);
    expect(chamadas.gravados[0].refs[0].impostoOriginal).toBeNull();
  });
});

describe("detalhe: o que a tela precisa para mostrar e decidir (contrato do G1)", () => {
  async function detalhe(o: Parameters<typeof montar>[0] = {}) {
    const { uc } = montar(o);
    return uc.detalhe("tenant", "dev-dls");
  }

  it("emitente com as opções de PIS/COFINS DESTA devolução (compra do Simples: sem 01/02, 49 primeiro)", async () => {
    const d = await detalhe();
    expect(d.emitente.tipoDevolucao).toBe("COMPRA_SAIDA");
    const codigos = (d.emitente.pisCofinsOpcoes ?? []).map((o) => o.codigo);
    expect(codigos[0]).toBe("49");
    expect(codigos).not.toContain("01");
    expect(codigos).not.toContain("02");
  });

  it("totais da nota (a MESMA conta da emissão) e a referência do imposto da nota do fornecedor por item", async () => {
    const d = await detalhe();
    expect(d.totais).toMatchObject({ totalProdutos: 419.44, totalNota: 419.44 });
    expect(d.itens[0].referenciaOriginal?.deQuem).toBe("FORNECEDOR");
    expect(d.itens[0].referenciaOriginal?.frases.icms).toMatch(/^Na nota do fornecedor: CST 00 · base R\$ 123,56 · 12% · ICMS R\$ 14,83/);
  });

  it("pela chave não há imposto original: referenciaOriginal null", async () => {
    const d = await detalhe({ fonte: "MANUAL", itens: [ITEM6] });
    expect(d.itens[0].referenciaOriginal).toBeNull();
  });

  it("K13: o item mostra onde mais ele está — rascunhos (não seguram saldo) e devoluções em envio", async () => {
    const d = await detalhe({
      linhas: [
        linha(6, 1, "DRAFT", { devolucaoNfeId: "37cfa045", numeroDevolucao: -38, serieDevolucao: 1, criadaEm: new Date("2026-09-24T21:26:00Z") }),
        linha(6, 1, "CANCELLED", { devolucaoNfeId: "velha" }),
      ],
    });
    const item6 = d.itens.find((i) => i.nItem === 6) as unknown as { emRascunho: number; disponivel: number; outrasDevolucoes: unknown[] };
    expect(item6.emRascunho).toBe(1);
    expect(item6.disponivel).toBe(1);
    expect(item6.outrasDevolucoes).toEqual([{ nfeId: "37cfa045", status: "DRAFT", numero: null, serie: 1, quantidade: 1, criadaEm: "2026-09-24T21:26:00.000Z" }]);
  });
});

describe("registrarAutorizacao: idempotente (o replay depois de queda pode chamar de novo)", () => {
  it("já registrada: não grava nada de novo", async () => {
    const dados = persistida();
    const { repo, chamadas } = repoEmMemoria({ persistidas: { "dev-dls": dados }, eventos: ["DEVOLUCAO_AUTORIZADA"] });
    await casoDeUso(repo).registrarAutorizacao("tenant", "dev-dls");
    expect(chamadas.audits).toHaveLength(0);
  });

  it("primeira vez: grava DEVOLUCAO_AUTORIZADA; pela chave, o excesso é conferido com a quantidade que o livro conhece", async () => {
    const dados = persistida({ fonte: "MANUAL", itens: [ITEM6] });
    const { repo, chamadas } = repoEmMemoria({
      persistidas: { "dev-dls": dados },
      linhas: [linha(6, 1, "AUTHORIZED", { fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "1" }), linha(6, 1, "AUTHORIZED", { devolucaoNfeId: "dev-dls" })],
    });
    await casoDeUso(repo).registrarAutorizacao("tenant", "dev-dls");
    expect(chamadas.audits.map((a) => a.evento)).toEqual(["DEVOLUCAO_SALDO_EXCEDIDO", "DEVOLUCAO_AUTORIZADA"]);
  });
});
