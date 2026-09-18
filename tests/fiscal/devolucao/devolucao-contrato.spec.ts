import { describe, expect, it } from "vitest";

import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import {
  DEVOLUCAO_ERRO_CODIGOS,
  DEVOLUCAO_ERRO_HTTP,
  DEVOLUCAO_ERRO_MENSAGEM,
  DEVOLUCAO_XML_MAX_CARACTERES,
  isDevolucaoErroCodigo,
  parseAtualizarCabecalhoBody,
  parseAtualizarItensBody,
  parseCriarDevolucaoBody,
  parseCriarDevolucaoResposta,
  parseManualBody,
  respostaErroDevolucao,
} from "../../../app/fiscal/devolucao/contrato";

const B = "4126091138627600017655003000000012100000012";
const CHAVE = B + calcularDvChaveAcesso(B);

describe("códigos de erro", () => {
  it("todo código tem HTTP e mensagem; os do plano §6.3 existem", () => {
    for (const c of DEVOLUCAO_ERRO_CODIGOS) {
      expect([400, 404, 409, 422]).toContain(DEVOLUCAO_ERRO_HTTP[c]);
      expect(DEVOLUCAO_ERRO_MENSAGEM[c].length).toBeGreaterThan(0);
    }
    for (const c of ["NAO_ENCONTRADA", "CANCELADA", "SEM_XML", "TOTALMENTE_DEVOLVIDA", "EXIGE_NUMERACAO_V2", "RECUSA_NAO_E_DEVOLUCAO", "EMITENTE_ORIGINAL_AUSENTE"]) {
      expect(isDevolucaoErroCodigo(c)).toBe(true);
    }
    expect(DEVOLUCAO_ERRO_HTTP.NAO_ENCONTRADA).toBe(404);
    expect(DEVOLUCAO_ERRO_HTTP.TOTALMENTE_DEVOLVIDA).toBe(409);
    expect(DEVOLUCAO_ERRO_HTTP.CANCELADA).toBe(409);
    expect(DEVOLUCAO_ERRO_HTTP.SEM_XML).toBe(409);
    expect(DEVOLUCAO_ERRO_HTTP.EXIGE_NUMERACAO_V2).toBe(422);
    expect(isDevolucaoErroCodigo("QUALQUER")).toBe(false);
  });

  it("respostaErroDevolucao monta status e corpo", () => {
    expect(respostaErroDevolucao("TOTALMENTE_DEVOLVIDA")).toEqual({
      status: 409,
      body: { error: DEVOLUCAO_ERRO_MENSAGEM.TOTALMENTE_DEVOLVIDA, code: "TOTALMENTE_DEVOLVIDA" },
    });
    const r = respostaErroDevolucao("DEVOLUCAO_INVALIDA", {
      mensagem: "x",
      issues: [{ code: "SEM_ITENS", severidade: "ERRO", mensagem: "m" }],
      draftId: "d1",
    });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "x", code: "DEVOLUCAO_INVALIDA", issues: [{ code: "SEM_ITENS", severidade: "ERRO", mensagem: "m" }], draftId: "d1" });
  });
});

describe("parseCriarDevolucaoBody", () => {
  it("corpo ausente vale {}; escopo opcional; lixo descartado", () => {
    expect(parseCriarDevolucaoBody(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCriarDevolucaoBody({})).toEqual({ ok: true, value: {} });
    expect(parseCriarDevolucaoBody({ escopo: "PARCIAL", forcarNovo: true })).toEqual({ ok: true, value: { escopo: "PARCIAL" } });
    expect(parseCriarDevolucaoBody({ escopo: "TUDO" }).ok).toBe(false);
    expect(parseCriarDevolucaoBody("x").ok).toBe(false);
    expect(parseCriarDevolucaoBody([]).ok).toBe(false);
  });
});

describe("parseAtualizarCabecalhoBody", () => {
  it("aceita devolvidaAposEntrega true/false/null, escopo e tipo", () => {
    expect(parseAtualizarCabecalhoBody({ devolvidaAposEntrega: true, escopo: "TOTAL", tipo: "COMPRA_SAIDA", x: 1 })).toEqual({
      ok: true,
      value: { devolvidaAposEntrega: true, escopo: "TOTAL", tipo: "COMPRA_SAIDA" },
    });
    expect(parseAtualizarCabecalhoBody({ devolvidaAposEntrega: null })).toEqual({ ok: true, value: { devolvidaAposEntrega: null } });
    const r = parseAtualizarCabecalhoBody({ devolvidaAposEntrega: "sim", tipo: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros.map((e) => e.campo)).toEqual(["devolvidaAposEntrega", "tipo"]);
  });
});

describe("parseAtualizarItensBody", () => {
  const item = { chaveAcesso: "NFe" + CHAVE, nItem: 1, quantidade: 1.5, cfop: "1202" };

  it("normaliza a chave e mantém só os campos do contrato", () => {
    const r = parseAtualizarItensBody({
      itens: [{ ...item, lixo: 1, confirmarTributacao: true, tributacao: { icms: { csosn: "900", pICMS: 12 }, pis: { cst: "49", p: 0 }, ipiDevol: false, extra: 1 } }],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        itens: [
          {
            chaveAcesso: CHAVE,
            nItem: 1,
            quantidade: 1.5,
            cfop: "1202",
            confirmarTributacao: true,
            tributacao: { icms: { csosn: "900", pICMS: 12 }, pis: { cst: "49", p: 0 }, ipiDevol: false },
          },
        ],
      },
    });
  });

  it("recusa lista vazia, chave inválida, nItem fora, quantidade ≤ 0 ou com 5 casas, CFOP ausente", () => {
    expect(parseAtualizarItensBody({ itens: [] }).ok).toBe(false);
    expect(parseAtualizarItensBody({}).ok).toBe(false);
    const r = parseAtualizarItensBody({
      itens: [
        { ...item, chaveAcesso: CHAVE.slice(0, 43) + "0".replace("0", String((Number(CHAVE[43]) + 1) % 10)) },
        { ...item, nItem: 991 },
        { ...item, quantidade: 0 },
        { ...item, quantidade: 1.00001 },
        { ...item, cfop: "" },
        { ...item, tributacao: { icms: { cst: "00", csosn: "102" } } },
        { ...item, tributacao: { pis: { p: 101 } } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erros.map((e) => e.campo)).toEqual([
      "itens[0].chaveAcesso",
      "itens[1].nItem",
      "itens[2].quantidade",
      "itens[3].quantidade",
      "itens[4].cfop",
      "itens[5].tributacao.icms",
      "itens[6].tributacao.pis.p",
    ]);
  });

  it("1072: mesmo chave+nItem duas vezes é recusado (mesmo com prefixo NFe)", () => {
    const r = parseAtualizarItensBody({ itens: [item, { ...item, chaveAcesso: CHAVE }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros[0].mensagem).toMatch(/1072/);
  });

  it("aceita quantidade em texto decimal", () => {
    const r = parseAtualizarItensBody({ itens: [{ ...item, quantidade: "2.0000" }] });
    expect(r.ok && r.value.itens[0].quantidade).toBe(2);
  });
});

describe("parseManualBody", () => {
  it("modo XML", () => {
    const r = parseManualBody({ tipo: "COMPRA_SAIDA", xmlOriginal: "<nfeProc/>", itens: [{ nItem: 2, quantidade: 1 }], devolvidaAposEntrega: true });
    expect(r).toEqual({
      ok: true,
      value: {
        tipo: "COMPRA_SAIDA",
        companyFiscalConfigId: null,
        devolvidaAposEntrega: true,
        escopo: null,
        modo: "XML",
        xmlOriginal: "<nfeProc/>",
        confirmarSemXml: false,
        itens: [{ nItem: 2, quantidade: 1 }],
      },
    });
  });

  it("XML e chave juntos, nenhum dos dois, tipo ausente ou XML grande demais são recusados", () => {
    expect(parseManualBody({ tipo: "VENDA_ENTRADA", xmlOriginal: "<a/>", chaveAcesso: CHAVE }).ok).toBe(false);
    expect(parseManualBody({ tipo: "VENDA_ENTRADA" }).ok).toBe(false);
    expect(parseManualBody({ xmlOriginal: "<a/>" }).ok).toBe(false);
    expect(parseManualBody({ tipo: "VENDA_ENTRADA", xmlOriginal: "x".repeat(DEVOLUCAO_XML_MAX_CARACTERES + 1) }).ok).toBe(false);
  });

  const itemManual = {
    nItem: 3, codigo: "PECA-1", descricao: "SENSOR ABS", ncm: "87089990", unidade: "UN",
    cfopOriginal: "5102", quantidadeOriginal: null, valorUnitario: 80, quantidade: 1,
  };

  it("modo CHAVE exige confirmarSemXml: true", () => {
    const sem = parseManualBody({ tipo: "COMPRA_SAIDA", chaveAcesso: CHAVE, itens: [itemManual] });
    expect(sem.ok).toBe(false);
    if (!sem.ok) expect(sem.erros.map((e) => e.campo)).toEqual(["confirmarSemXml"]);

    const ok = parseManualBody({
      tipo: "COMPRA_SAIDA",
      chaveAcesso: "NFe" + CHAVE,
      itens: [itemManual],
      confirmarSemXml: true,
      destinatario: { tipoPessoa: "PJ", cpfCnpj: "07504505000132", nome: " FORNECEDOR ", uf: "PR", hack: { a: 1 } },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value).toMatchObject({ modo: "CHAVE", chaveAcesso: CHAVE, confirmarSemXml: true });
    expect(ok.value.modo === "CHAVE" && ok.value.destinatario).toEqual({ tipoPessoa: "PJ", cpfCnpj: "07504505000132", nome: "FORNECEDOR", uf: "PR" });
    expect(ok.value.modo === "CHAVE" && ok.value.itens[0]).toEqual({
      nItem: 3, codigo: "PECA-1", descricao: "SENSOR ABS", ncm: "87089990", cest: null, unidade: "UN", origem: null,
      cfopOriginal: "5102", cfop: null, quantidadeOriginal: null, valorUnitario: 80, quantidade: 1,
    });
  });

  it("modo CHAVE valida itens (NCM, quantidade acima da original, repetidos)", () => {
    const r = parseManualBody({
      tipo: "VENDA_ENTRADA",
      chaveAcesso: CHAVE,
      confirmarSemXml: true,
      itens: [
        { ...itemManual, ncm: "8708" },
        { ...itemManual, nItem: 4, quantidadeOriginal: 1, quantidade: 2 },
        { ...itemManual, nItem: 5 },
        { ...itemManual, nItem: 5 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros.map((e) => e.campo)).toEqual(["itens[0].ncm", "itens[1].quantidade", "itens[3]"]);
  });
});

describe("parseCriarDevolucaoResposta", () => {
  it("lê draftId e reutilizado", () => {
    expect(parseCriarDevolucaoResposta({ draftId: "d1", reutilizado: true })).toEqual({ ok: true, value: { draftId: "d1", reutilizado: true } });
    expect(parseCriarDevolucaoResposta({ draftId: "d1" })).toEqual({ ok: true, value: { draftId: "d1", reutilizado: false } });
    expect(parseCriarDevolucaoResposta({}).ok).toBe(false);
    expect(parseCriarDevolucaoResposta(null).ok).toBe(false);
  });
});
