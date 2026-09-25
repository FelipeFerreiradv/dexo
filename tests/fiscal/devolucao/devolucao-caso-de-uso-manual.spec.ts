/**
 * Devolução MANUAL pelo caso de uso (POST /fiscal/nfe/devolucao/manual) — nenhum teste
 * chamava `manual()` antes (achado N-completude-2).
 *
 * Casos reais da DLS AUTO PEÇAS (Simples, SC), 24/09/2026, devolução de COMPRA à DISAUTO:
 * - N-saldo-ledger-2: o XML montava os 6 itens com o qCom cheio e ignorava o livro de
 *   devoluções — a 2ª devolução da mesma nota do fornecedor não nascia.
 * - K13: cada clique em "Criar rascunho" criava OUTRO (5 da mesma nota).
 * - K6: pela chave (sem XML) a mesma peça podia ser devolvida de novo.
 * - N-icms-residual-3: pela chave, a origem informada não chegava ao ICMS (saía 0).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualValidado } from "../../../app/fiscal/devolucao/contrato";
import {
  CHAVE_DISAUTO, CNPJ_DISAUTO, CNPJ_DLS, ITENS_DISAUTO, casoDeUso, chave, configDls, erroDe, linha, repoEmMemoria, stubFlags, xmlCompraDisauto,
} from "./devolucao-caso-de-uso-fixtures";

beforeEach(stubFlags);
afterEach(() => { vi.unstubAllEnvs(); });

const porXml = (over: Partial<ManualValidado> = {}): ManualValidado => ({
  modo: "XML", tipo: "COMPRA_SAIDA", companyFiscalConfigId: "cfg-dls", devolvidaAposEntrega: null, escopo: null,
  xmlOriginal: xmlCompraDisauto(ITENS_DISAUTO), confirmarSemXml: false, itens: null, ...over,
} as ManualValidado);

const itemDigitado = (over: Record<string, unknown> = {}) => ({
  nItem: 6, codigo: "24171-7", descricao: "BOMBA OLEO", ncm: "84133090", cest: null, unidade: "UN", origem: null,
  cfopOriginal: "5102", cfop: null, quantidadeOriginal: null, valorUnitario: 295.88, quantidade: 1, ...over,
});
const pelaChave = (over: Record<string, unknown> = {}): ManualValidado => ({
  modo: "CHAVE", tipo: "COMPRA_SAIDA", companyFiscalConfigId: "cfg-dls", devolvidaAposEntrega: null, escopo: null,
  chaveAcesso: CHAVE_DISAUTO, confirmarSemXml: true,
  destinatario: { tipoPessoa: "PJ", cpfCnpj: CNPJ_DISAUTO, nome: "DISAUTO", uf: null },
  itens: [itemDigitado()], ...over,
} as ManualValidado);

describe("devolução manual pelo XML: nasce com o que AINDA pode ser devolvido (N-saldo-ledger-2)", () => {
  it("primeira devolução (nada devolvido antes): os 6 itens com o qCom cheio, e o escopo sai TOTAL", async () => {
    const { repo, chamadas } = repoEmMemoria();
    const r = await casoDeUso(repo).manual("tenant", "tenant", porXml());
    expect(r).toEqual({ draftId: "novo-rascunho", reutilizado: false });
    const m = chamadas.criados[0];
    expect(m.refs.map((x: any) => [x.nItemOriginal, x.quantidade])).toEqual([[1, 3], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]]);
    expect(m.escopo).toBe("TOTAL");
  });

  it("2ª devolução da mesma nota: o item 5 já devolvido (autorizado) fica de fora — antes: 409 'Quantidade maior que o saldo'", async () => {
    const { repo, chamadas } = repoEmMemoria({ linhas: [linha(5, 1, "AUTHORIZED", { fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "1" })] });
    await casoDeUso(repo).manual("tenant", "tenant", porXml());
    const m = chamadas.criados[0];
    expect(m.refs.map((x: any) => x.nItemOriginal)).toEqual([1, 2, 3, 4, 6]);
    // ordem contínua (gravarItens exige ordem === número do item)
    expect(m.refs.map((x: any) => x.ordem)).toEqual([1, 2, 3, 4, 5]);
    expect(m.itens.map((x: any) => x.numero)).toEqual([1, 2, 3, 4, 5]);
    expect(m.escopo).toBe("PARCIAL");
  });

  it("item parcialmente devolvido (1 de 3 em envio à SEFAZ) nasce com o resto: 2", async () => {
    const { repo, chamadas } = repoEmMemoria({ linhas: [linha(1, 1, "SENDING")] });
    await casoDeUso(repo).manual("tenant", "tenant", porXml());
    expect(chamadas.criados[0].refs.find((x: any) => x.nItemOriginal === 1).quantidade).toBe(2);
  });

  it("rascunho de OUTRA devolução não segura saldo: o item continua cheio", async () => {
    const { repo, chamadas } = repoEmMemoria({ linhas: [linha(1, 3, "DRAFT")] });
    await casoDeUso(repo).manual("tenant", "tenant", porXml());
    expect(chamadas.criados[0].refs.find((x: any) => x.nItemOriginal === 1).quantidade).toBe(3);
  });

  it("nota toda devolvida: TOTALMENTE_DEVOLVIDA, sem criar nada", async () => {
    const { repo, chamadas } = repoEmMemoria({ linhas: ITENS_DISAUTO.map((i) => linha(i.nItem, i.qCom, "AUTHORIZED")) });
    const e = await erroDe(casoDeUso(repo).manual("tenant", "tenant", porXml()));
    expect(e.code).toBe("TOTALMENTE_DEVOLVIDA");
    expect(chamadas.criados).toHaveLength(0);
  });

  it("seleção acima do saldo: SALDO_INSUFICIENTE com o item, o disponível e onde está o resto", async () => {
    const { repo } = repoEmMemoria({ linhas: [linha(1, 2, "AUTHORIZED")] });
    const e = await erroDe(casoDeUso(repo).manual("tenant", "tenant", porXml({ itens: [{ nItem: 1, quantidade: 3 }] } as never)));
    expect(e.code).toBe("SALDO_INSUFICIENTE");
    expect(e.httpStatus).toBe(409);
    expect(e.issues).toHaveLength(1);
    expect(e.issues[0]).toMatchObject({ code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: 1 });
    expect(e.issues[0].mensagem).toBe(
      "Item 1: 11111-1 (item 1 da nota original): a quantidade 3 passa do que ainda pode ser devolvido, que é 1 (2 já devolvido em NF-e autorizada).",
    );
  });

  it("'Total' pedido numa nota já parcialmente devolvida é recusado como em 'Devolver total'", async () => {
    const { repo } = repoEmMemoria({ linhas: [linha(5, 1, "AUTHORIZED")] });
    const e = await erroDe(casoDeUso(repo).manual("tenant", "tenant", porXml({ escopo: "TOTAL" } as never)));
    expect(e.code).toBe("PARCIALMENTE_DEVOLVIDA");
  });
});

describe("devolução manual: rascunho aberto da MESMA nota é reaproveitado (K13)", () => {
  it("pelo XML: devolve o rascunho aberto (reutilizado) e não cria outro", async () => {
    const { repo, chamadas } = repoEmMemoria({ aberta: "8d269885" });
    const r = await casoDeUso(repo).manual("tenant", "tenant", porXml());
    expect(r).toEqual({ draftId: "8d269885", reutilizado: true });
    expect(chamadas.criados).toHaveLength(0);
    // procurado pela chave do XML E pelo tipo (uma devolução de venda não serve)
    expect(chamadas.aberta[0][1]).toBe(CHAVE_DISAUTO);
    expect(chamadas.aberta[0][3]).toBe("COMPRA_SAIDA");
  });

  it("pela chave, com os MESMOS itens digitados: reaproveita", async () => {
    const snapshot = { chaveAcesso: CHAVE_DISAUTO, itens: [{ nItem: 6, codigo: "24171-7", descricao: "BOMBA OLEO", ncm: "84133090", cest: null, unidade: "UN", cfop: "5102", quantidade: 0, valorUnitario: 295.88, origem: null }] };
    const { repo, chamadas } = repoEmMemoria({ aberta: "r1", persistidas: { r1: { cabecalho: { origensJson: [snapshot] }, refs: [], nota: {} } } });
    const r = await casoDeUso(repo).manual("tenant", "tenant", pelaChave());
    expect(r).toEqual({ draftId: "r1", reutilizado: true });
    expect(chamadas.criados).toHaveLength(0);
  });

  it("pela chave, com item DIFERENTE do rascunho aberto: cria outro (o rascunho não comporta o que ela digitou)", async () => {
    const snapshot = { chaveAcesso: CHAVE_DISAUTO, itens: [{ nItem: 6, codigo: "24171-7", descricao: "OUTRA DESCRICAO", ncm: "84133090", cest: null, unidade: "UN", cfop: "5102", quantidade: 0, valorUnitario: 295.88, origem: null }] };
    const { repo, chamadas } = repoEmMemoria({ aberta: "r1", persistidas: { r1: { cabecalho: { origensJson: [snapshot] }, refs: [], nota: {} } } });
    const r = await casoDeUso(repo).manual("tenant", "tenant", pelaChave());
    expect(r).toEqual({ draftId: "novo-rascunho", reutilizado: false });
  });
});

describe("devolução manual pela CHAVE (sem XML)", () => {
  it("chave da PRÓPRIA empresa numa devolução de compra: 400 com o campo e a frase, sem criar", async () => {
    const { repo, chamadas } = repoEmMemoria();
    const e = await erroDe(casoDeUso(repo).manual("tenant", "tenant", pelaChave({
      chaveAcesso: chave(CNPJ_DLS, 713), destinatario: { tipoPessoa: "PJ", cpfCnpj: CNPJ_DLS, nome: "DLS", uf: null },
    })));
    expect(e.code).toBe("PAYLOAD_INVALIDO");
    expect(e.httpStatus).toBe(400);
    expect(e.erros.map((x: any) => x.campo)).toContain("chaveAcesso");
    expect(chamadas.criados).toHaveLength(0);
  });

  it("K6: a peça que uma devolução do XML já devolveu NÃO passa de novo pela chave (quantidade original do livro)", async () => {
    const { repo, chamadas } = repoEmMemoria({
      linhas: [linha(6, 1, "AUTHORIZED", { fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "1" })],
    });
    const e = await erroDe(casoDeUso(repo).manual("tenant", "tenant", pelaChave()));
    expect(e.code).toBe("SALDO_INSUFICIENTE");
    expect(e.issues[0].mensagem).toContain("este item não tem mais saldo para devolver (1 já devolvido em NF-e autorizada)");
    expect(chamadas.criados).toHaveLength(0);
  });

  it("K6: quantidade digitada à mão em OUTRA devolução pela chave não vira régua (só a de XML vale)", async () => {
    const { repo, chamadas } = repoEmMemoria({
      linhas: [linha(6, 1, "DRAFT", { fonteDevolucao: "MANUAL", quantidadeOriginal: "1" })],
    });
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave({ itens: [itemDigitado({ quantidade: 2 })] }));
    const m = chamadas.criados[0];
    expect(m.origem.itens[0].quantidade).toBe(0);
    expect(m.refs[0].quantidadeOriginal).toBeNull();
  });

  it("a quantidade original conhecida pelo livro vai para o rascunho (saldo verificável dali em diante)", async () => {
    const { repo, chamadas } = repoEmMemoria({
      linhas: [linha(6, 1, "CANCELLED", { fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "1" })],
    });
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave());
    const m = chamadas.criados[0];
    expect(m.origem.itens[0].quantidade).toBe(1);
    expect(m.refs[0].quantidadeOriginal).toBe(1);
  });

  it("a origem informada (5 = importação ≤ 40%) vai para o ICMS do item — antes o XML saía <orig>0</orig>", async () => {
    const { repo, chamadas } = repoEmMemoria();
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave({ itens: [itemDigitado({ origem: 5 })] }));
    expect(chamadas.criados[0].refs[0].tributacao.icms.orig).toBe(5);
    expect(chamadas.criados[0].itens[0].origem).toBe(5);
  });

  it("sem origem informada, o ICMS fica SEM origem (nada é inventado)", async () => {
    const { repo, chamadas } = repoEmMemoria();
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave());
    expect(chamadas.criados[0].refs[0].tributacao.icms.orig).toBeNull();
  });

  it("devolução de compra: destino e UF do fornecedor saem da CHAVE (fornecedor do PR, empresa de SC ⇒ interestadual)", async () => {
    const { repo, chamadas } = repoEmMemoria();
    const chavePr = chave(CNPJ_DISAUTO, 900, "41");
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave({ chaveAcesso: chavePr }));
    const m = chamadas.criados[0];
    expect(m.cabecalho.destinoOperacao).toBe("INTERESTADUAL");
    expect(m.cabecalho.destinatarioJson.uf).toBe("PR");
    expect(m.origem.idDest).toBe(2);
  });

  it("devolução de venda pela chave de uma nota do Dexo: grava o vínculo e a quantidade do NfeItem (mesmo nº e código)", async () => {
    const chaveVenda = chave(CNPJ_DLS, 713);
    const { repo, chamadas } = repoEmMemoria({ notaPorChave: { id: "orig-713", xmlAutorizadoPath: null, itens: [{ numero: 2, codigo: "PECA-2", quantidade: "4.0000" }] } });
    const venda = pelaChave({
      tipo: "VENDA_ENTRADA", chaveAcesso: chaveVenda,
      destinatario: { tipoPessoa: "PJ", cpfCnpj: "11222333000181", nome: "CLIENTE", uf: "SC" },
      itens: [itemDigitado({ nItem: 2, codigo: "PECA-2", quantidade: 1 })],
    });
    await casoDeUso(repo).manual("tenant", "tenant", venda);
    const m = chamadas.criados[0];
    expect(m.origem.originalNfeId).toBe("orig-713");
    expect(m.refs[0].originalNfeId).toBe("orig-713");
    expect(m.refs[0].quantidadeOriginal).toBe(4);

    const acima = await erroDe(casoDeUso(repoEmMemoria({ notaPorChave: { id: "orig-713", xmlAutorizadoPath: null, itens: [{ numero: 2, codigo: "PECA-2", quantidade: "4.0000" }] } }).repo)
      .manual("tenant", "tenant", { ...venda, itens: [itemDigitado({ nItem: 2, codigo: "PECA-2", quantidade: 5 })] } as ManualValidado));
    expect(acima.code).toBe("SALDO_INSUFICIENTE");
    expect(acima.issues[0].mensagem).toContain("passa do que ainda pode ser devolvido, que é 4");
  });

  it("NfeItem com OUTRO código no mesmo nº não é usado (o nº pode não ser o do XML)", async () => {
    const chaveVenda = chave(CNPJ_DLS, 713);
    const { repo, chamadas } = repoEmMemoria({ notaPorChave: { id: "orig-713", xmlAutorizadoPath: null, itens: [{ numero: 2, codigo: "OUTRA", quantidade: "4" }] } });
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave({
      tipo: "VENDA_ENTRADA", chaveAcesso: chaveVenda,
      destinatario: { tipoPessoa: "PJ", cpfCnpj: "11222333000181", nome: "CLIENTE", uf: "SC" },
      itens: [itemDigitado({ nItem: 2, codigo: "PECA-2" })],
    }));
    expect(chamadas.criados[0].refs[0].quantidadeOriginal).toBeNull();
  });

  it("devolução de compra SEM destinatário digitado: o destino sai da chave do fornecedor (PR ⇒ interestadual)", async () => {
    const { repo, chamadas } = repoEmMemoria();
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave({ chaveAcesso: chave(CNPJ_DISAUTO, 900, "41"), destinatario: null }));
    expect(chamadas.criados[0].cabecalho.destinoOperacao).toBe("INTERESTADUAL");
  });

  it("devolução de venda sem a UF do cliente: o destino sai do CFOP da venda (6102 ⇒ interestadual)", async () => {
    const { repo, chamadas } = repoEmMemoria();
    await casoDeUso(repo).manual("tenant", "tenant", pelaChave({
      tipo: "VENDA_ENTRADA", chaveAcesso: chave(CNPJ_DLS, 714),
      destinatario: { tipoPessoa: "PF", cpfCnpj: "12345678909", nome: "CLIENTE", uf: null },
      itens: [itemDigitado({ nItem: 1, codigo: "PECA-1", cfopOriginal: "6102" })],
    }));
    expect(chamadas.criados[0].cabecalho.destinoOperacao).toBe("INTERESTADUAL");
  });

  it("fornecedor da MESMA UF da empresa (SC): interna, e a UF do destinatário vem da chave", async () => {
    const { repo, chamadas } = repoEmMemoria();
    await casoDeUso(repo, configDls()).manual("tenant", "tenant", pelaChave());
    expect(chamadas.criados[0].cabecalho.destinoOperacao).toBe("INTERNA");
    expect(chamadas.criados[0].cabecalho.destinatarioJson.uf).toBe("SC");
  });
});

describe("prévia da devolução manual (só leitura): as peças, o saldo de cada uma e o CFOP sugerido", () => {
  it("DISAUTO com o item 5 já devolvido: mostra o disponível de cada item, o CFOP de devolução e o rascunho aberto — sem criar", async () => {
    const { repo, chamadas } = repoEmMemoria({ aberta: "8d269885", linhas: [linha(5, 1, "AUTHORIZED"), linha(1, 1, "DRAFT")] });
    const p = await casoDeUso(repo).previaManual("tenant", porXml());
    expect(chamadas.criados).toHaveLength(0);
    expect(p).toMatchObject({ chaveAcesso: CHAVE_DISAUTO, numero: 852899, serie: 1, emitenteCnpjCpf: CNPJ_DISAUTO, destinatarioNome: "DISAUTO", rascunhoAberto: "8d269885" });
    expect(p.itens.map((i) => [i.nItem, i.quantidadeOriginal, i.disponivel, i.devolvidaAutorizada, i.emRascunho])).toEqual([
      [1, 3, 3, 0, 1], [2, 1, 1, 0, 0], [3, 1, 1, 0, 0], [4, 1, 1, 0, 0], [5, 1, 0, 1, 0], [6, 1, 1, 0, 0],
    ]);
    // Venda do fornecedor (5102) não diz a finalidade da nossa entrada: ela escolhe, e as opções vêm prontas.
    expect(p.itens[5]).toMatchObject({ codigo: "24171-7", cfopOriginal: "5102", cfopSugerido: null, cfopStatus: "ESCOLHA" });
    expect(p.itens[5].cfopOpcoes[0]).toBe("5202");
    expect(chamadas.aberta[0][3]).toBe("COMPRA_SAIDA");
  });

  it("pela chave da própria empresa numa compra: a mesma recusa de campo da criação", async () => {
    const { repo } = repoEmMemoria();
    const e = await erroDe(casoDeUso(repo).previaManual("tenant", pelaChave({ chaveAcesso: chave(CNPJ_DLS, 713), destinatario: null })));
    expect(e.code).toBe("PAYLOAD_INVALIDO");
    expect(e.erros[0].campo).toBe("chaveAcesso");
  });
});
