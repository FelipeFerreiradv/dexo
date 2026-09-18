import { describe, expect, it } from "vitest";
import {
  classificarConsultaSefaz,
  classificarCStatSefaz,
  classificarEnvioSefaz,
  classificarGetFocus,
  classificarPostFocus,
  extrairChaveReferida,
  normalizarCStat,
  provaMadura,
} from "../../../app/fiscal/numeracao/classificacao";
import * as cstat from "../../../app/fiscal/numeracao/cstat";
import type {
  Classificacao,
  FocusV2Corpo,
  FocusV2Resposta,
  SefazConsultaDetalhada,
  SefazTransmissao,
} from "../../../app/fiscal/numeracao/tipos";

// Tabelas do plano §4.3 / design §4.8, linha a linha. Toda classificação passa
// por `ok()`, que confere o contrato: acao NENHUMA ⇔ estadoAlvo preenchido;
// nunca ABANDONADO/EM_TRANSMISSAO/CANCELADO; mensagem pt-BR não vazia.

const CHAVE = "35260911386276000176550030000001011000001017";
const CHAVE_OUTRA = "35260911386276000176550030000001011999999990";
const DIGEST = "abcDigest+/=";

function ok(c: Classificacao): Classificacao {
  expect(c.acao === "NENHUMA").toBe(c.estadoAlvo !== null);
  expect(["ABANDONADO", "EM_TRANSMISSAO", "CANCELADO"]).not.toContain(c.estadoAlvo);
  expect(typeof c.mensagem).toBe("string");
  expect(c.mensagem.length).toBeGreaterThan(0);
  expect(c.mensagem.toLowerCase()).not.toMatch(/token=|senha|password|authorization/);
  if (c.retryAposMs !== null) expect(c.retryAposMs).toBeGreaterThan(0);
  return c;
}

function tx(p: Partial<SefazTransmissao> = {}): SefazTransmissao {
  return {
    transporte: null,
    httpStatus: 200,
    loteCStat: null,
    loteXMotivo: "",
    protCStat: null,
    protXMotivo: "",
    nProt: null,
    dhRecbto: null,
    nRec: null,
    chNFe: null,
    protNFeXml: null,
    xmlAutorizado: null,
    ...p,
  };
}

/** Resposta síncrona com protNFe (lote 104). */
function prot(cStat: number, extra: Partial<SefazTransmissao> = {}): SefazTransmissao {
  return tx({ loteCStat: 104, protCStat: cStat, protXMotivo: `Motivo ${cStat}`, ...extra });
}

function envio(t: SefazTransmissao) {
  return ok(classificarEnvioSefaz(t));
}

function cons(p: Partial<SefazConsultaDetalhada> = {}): SefazConsultaDetalhada {
  return {
    transporte: null,
    httpStatus: 200,
    cStat: null,
    xMotivo: "",
    nProt: null,
    dhRecbto: null,
    digVal: null,
    chNFe: null,
    protNFeXml: null,
    ...p,
  };
}

const CTX_CONSULTA = { chavesNossas: [CHAVE], digestsNossos: [DIGEST], madura: false };

function consulta(c: SefazConsultaDetalhada, ctx: Partial<typeof CTX_CONSULTA> = {}) {
  return ok(classificarConsultaSefaz(c, { ...CTX_CONSULTA, ...ctx }));
}

function focus(
  httpStatus: number | null,
  corpo: FocusV2Corpo | null,
  extra: Partial<FocusV2Resposta> = {},
): FocusV2Resposta {
  return { httpStatus, transporte: null, corpo, retryAfterMs: null, ...extra };
}

function post(r: FocusV2Resposta) {
  return ok(classificarPostFocus(r));
}

function get(r: FocusV2Resposta, ctx: { madura?: boolean; postConclusivo?: boolean } = {}) {
  return ok(classificarGetFocus(r, { madura: false, postConclusivo: false, ...ctx }));
}

function intervalo(de: number, ate: number): number[] {
  return Array.from({ length: ate - de + 1 }, (_, i) => de + i);
}

// ───────────────────────────────────────────────────────────────────────────

describe("reexport do normalizador (sem duplicar)", () => {
  it("normalizarCStat é o mesmo de ./cstat", () => {
    expect(normalizarCStat).toBe(cstat.normalizarCStat);
    expect(normalizarCStat("974")).toBe(974);
    expect(normalizarCStat("erro_validacao_schema")).toBeNull();
  });
});

describe("extrairChaveReferida", () => {
  it.each([
    [`Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe:${CHAVE}][nRec:351000012345678]`, CHAVE],
    [`Duplicidade [NFe${CHAVE}]`, CHAVE],
    [`${CHAVE} no início`, CHAVE],
    [`fim ${CHAVE}`, CHAVE],
    [`primeira ${CHAVE} segunda ${CHAVE_OUTRA}`, CHAVE],
    [`45 dígitos 9${CHAVE} depois ${CHAVE_OUTRA}`, CHAVE_OUTRA],
  ])("%s", (texto, esperado) => {
    expect(extrairChaveReferida(texto)).toBe(esperado);
  });

  it.each([
    ["sem chave"],
    [CHAVE.slice(0, 43)],
    [`${CHAVE}1`],
    [""],
    [null],
    [undefined],
    [12345],
  ])("sem chave de 44 dígitos: %j", (texto) => {
    expect(extrairChaveReferida(texto)).toBeNull();
  });
});

describe("provaMadura", () => {
  const t0 = new Date("2026-09-17T12:00:00.000Z");
  const depois = (msDepois: number) => new Date(t0.getTime() + msDepois);

  it("resposta conclusiva prova na hora", () => {
    expect(provaMadura({ transmitidaEm: t0, respostaConclusiva: true }, t0, 285_000)).toBe(true);
  });

  it.each([
    [284_999, false],
    [285_000, true],
    [285_001, true],
    [0, false],
  ])("default 285 000 ms: %i ms ⇒ %s", (decorrido, esperado) => {
    expect(provaMadura({ transmitidaEm: t0, respostaConclusiva: false }, depois(decorrido), 285_000)).toBe(esperado);
  });

  it.each([
    [119_000, false],
    [120_000, true],
  ])("minMs 120 000: %i ms ⇒ %s (bordas do design)", (decorrido, esperado) => {
    expect(provaMadura({ transmitidaEm: t0, respostaConclusiva: false }, depois(decorrido), 120_000)).toBe(esperado);
  });

  it("datas ou mínimo inválidos nunca provam", () => {
    expect(provaMadura({ transmitidaEm: new Date("x"), respostaConclusiva: false }, depois(10 ** 9), 1)).toBe(false);
    expect(provaMadura({ transmitidaEm: t0, respostaConclusiva: false }, new Date("x"), 1)).toBe(false);
    expect(provaMadura({ transmitidaEm: t0, respostaConclusiva: false }, depois(10 ** 9), NaN)).toBe(false);
    expect(provaMadura({ transmitidaEm: t0, respostaConclusiva: false }, depois(10 ** 9), -1)).toBe(false);
  });
});

// ─────────────────────────── A. SEFAZ direto: envio ───────────────────────────

describe("classificarEnvioSefaz — tabela A", () => {
  it.each([[100], [150]])("prot %i com nProt ⇒ AUTORIZADO", (c) => {
    const r = envio(prot(c, { nProt: "135260000000001" }));
    expect(r).toMatchObject({ classe: "AUTORIZADA", estadoAlvo: "AUTORIZADO", acao: "NENHUMA", cStat: c, conclusiva: false });
  });

  it.each([[100], [150]])("prot %i sem nProt ⇒ confirma por consulta (sem prova)", (c) => {
    expect(envio(prot(c))).toMatchObject({ estadoAlvo: null, acao: "CONSULTAR_CHAVE", cStat: c });
  });

  it.each([[110], [301], [302], [303]])("%i com nProt ⇒ DENEGADO conclusivo", (c) => {
    expect(envio(prot(c, { nProt: "135260000000009" }))).toMatchObject({
      classe: "DENEGADA",
      estadoAlvo: "DENEGADO",
      acao: "NENHUMA",
      cStat: c,
      conclusiva: true,
    });
  });

  it.each([[110], [301], [302], [303]])("%i sem nProt ⇒ CONSULTAR_CHAVE", (c) => {
    expect(envio(prot(c))).toMatchObject({
      classe: "DENEGACAO_A_CONFIRMAR",
      estadoAlvo: null,
      acao: "CONSULTAR_CHAVE",
      conclusiva: false,
    });
  });

  it.each([[110], [301]])("%i só no lote (sem protNFe) nunca vira DENEGADO", (c) => {
    expect(envio(tx({ loteCStat: c, nProt: "135260000000009" }))).toMatchObject({ acao: "CONSULTAR_CHAVE" });
  });

  it("204 ⇒ consulta pela chave (nunca renumera)", () => {
    expect(envio(prot(204, { protXMotivo: `Duplicidade de NF-e [chNFe:${CHAVE}]` }))).toMatchObject({
      classe: "DUPLICIDADE_MESMA_CHAVE",
      estadoAlvo: null,
      acao: "CONSULTAR_CHAVE",
      conclusiva: false,
      chaveReferida: CHAVE,
    });
  });

  it.each([[539], [562], [613]])("%i ⇒ RECONCILIAR_539 com a chave do xMotivo", (c) => {
    expect(
      envio(prot(c, { protXMotivo: `Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe:${CHAVE_OUTRA}]` })),
    ).toMatchObject({
      classe: "DUPLICIDADE_OUTRA_CHAVE",
      estadoAlvo: null,
      acao: "RECONCILIAR_539",
      cStat: c,
      conclusiva: true,
      chaveReferida: CHAVE_OUTRA,
    });
  });

  it("539 sem chave legível no xMotivo ⇒ RECONCILIAR_539 com chaveReferida null", () => {
    expect(envio(prot(539, { protXMotivo: "Duplicidade de NF-e" }))).toMatchObject({
      acao: "RECONCILIAR_539",
      chaveReferida: null,
    });
  });

  it("205 ⇒ consulta pela chave", () => {
    expect(envio(prot(205))).toMatchObject({ classe: "DENEGADA_NA_BASE", estadoAlvo: null, acao: "CONSULTAR_CHAVE" });
  });

  it("206 ⇒ INUTILIZADO", () => {
    expect(envio(prot(206))).toMatchObject({
      classe: "INUTILIZADA_NA_BASE",
      estadoAlvo: "INUTILIZADO",
      acao: "NENHUMA",
      conclusiva: true,
    });
  });

  it("218 ⇒ consulta pela chave (candidato a BLOQUEADO)", () => {
    expect(envio(prot(218))).toMatchObject({ classe: "CANCELADA_NA_BASE", estadoAlvo: null, acao: "CONSULTAR_CHAVE" });
  });

  it("635 ⇒ INCERTO: nem reuso nem número novo, não conclusivo", () => {
    const r = envio(prot(635));
    expect(r).toMatchObject({
      classe: "EM_PROCESSAMENTO_NA_SEFAZ",
      estadoAlvo: "INCERTO",
      acao: "NENHUMA",
      conclusiva: false,
    });
    expect(["RESERVADO", "REJEITADO", "DENEGADO", "INUTILIZADO", "CONSUMIDO_EXTERNO"]).not.toContain(r.estadoAlvo);
  });

  it.each([[108], [109]])("%i ⇒ RESERVADO conclusivo (mesmo número, sem SVC)", (c) => {
    expect(envio(tx({ loteCStat: c, loteXMotivo: "Servico Paralisado" }))).toMatchObject({
      classe: "SERVICO_INDISPONIVEL",
      estadoAlvo: "RESERVADO",
      acao: "NENHUMA",
      cStat: c,
      conclusiva: true,
    });
  });

  it("656 ⇒ REJEITADO + cooldown de 60 min (ou o valor passado)", () => {
    expect(envio(tx({ loteCStat: 656 }))).toMatchObject({
      classe: "CONSUMO_INDEVIDO",
      estadoAlvo: "REJEITADO",
      conclusiva: true,
      retryAposMs: 3_600_000,
    });
    expect(classificarEnvioSefaz(tx({ loteCStat: 656 }), { consumoIndevidoCooldownMs: 1234 }).retryAposMs).toBe(1234);
    expect(classificarEnvioSefaz(tx({ loteCStat: 656 }), { consumoIndevidoCooldownMs: -1 }).retryAposMs).toBe(3_600_000);
  });

  it("lote 103 com nRec ⇒ POLL_RECIBO; sem nRec ⇒ POLL_CHAVE", () => {
    expect(envio(tx({ loteCStat: 103, nRec: "351000012345678" }))).toMatchObject({
      classe: "EM_PROCESSAMENTO",
      estadoAlvo: null,
      acao: "POLL_RECIBO",
    });
    expect(envio(tx({ loteCStat: 103 }))).toMatchObject({ acao: "POLL_CHAVE" });
  });

  it.each([[104], [105]])("lote %i sem protNFe ⇒ POLL_CHAVE", (c) => {
    expect(envio(tx({ loteCStat: c }))).toMatchObject({ classe: "EM_PROCESSAMENTO", acao: "POLL_CHAVE", conclusiva: false });
  });

  it.each([["TIMEOUT"], ["REDE"], ["SEM_CREDENCIAL"]] as const)("transporte %s ⇒ INCERTO_TRANSPORTE/consulta", (t) => {
    expect(envio(tx({ transporte: t, httpStatus: null }))).toMatchObject({
      classe: "INCERTO_TRANSPORTE",
      estadoAlvo: null,
      acao: "CONSULTAR_CHAVE",
      conclusiva: false,
    });
  });

  it.each([[400], [403], [500], [502], [503]])("HTTP %i ⇒ consulta, mesmo com cStat no corpo", (s) => {
    expect(envio(tx({ httpStatus: s, loteCStat: 225, protCStat: 225 }))).toMatchObject({
      classe: "INCERTO_TRANSPORTE",
      acao: "CONSULTAR_CHAVE",
    });
  });

  it("sem cStat legível ⇒ consulta", () => {
    expect(envio(tx())).toMatchObject({ classe: "INCERTO_TRANSPORTE", acao: "CONSULTAR_CHAVE", cStat: null });
    expect(envio(tx({ httpStatus: null }))).toMatchObject({ acao: "CONSULTAR_CHAVE" });
  });

  it("rejeição no lote (sem protNFe) ⇒ REJEITADO com o cStat do lote", () => {
    expect(envio(tx({ loteCStat: 225, loteXMotivo: "Falha no Schema XML" }))).toMatchObject({
      classe: "REJEICAO",
      estadoAlvo: "REJEITADO",
      cStat: 225,
      conclusiva: true,
    });
  });

  it("protNFe tem precedência sobre o lote", () => {
    expect(envio(tx({ loteCStat: 225, protCStat: 100, nProt: "1" }))).toMatchObject({ estadoAlvo: "AUTORIZADO" });
  });

  it.each([
    [215],
    [225],
    [228],
    ...intervalo(280, 289).map((c) => [c]),
    [704],
    [778],
    [781],
    [897],
    [974],
    [975],
    [999],
  ])("rejeição %i ⇒ REJEITADO conclusivo, mesmo número", (c) => {
    expect(envio(prot(c))).toMatchObject({
      classe: "REJEICAO",
      estadoAlvo: "REJEITADO",
      acao: "NENHUMA",
      cStat: c,
      conclusiva: true,
      retryAposMs: null,
    });
  });

  it("TODO inteiro 200–999 fora da lista especial é REJEITADO", () => {
    // 301–303 sem nProt vão para consulta (denegação a confirmar).
    const especiais = new Set([204, 205, 206, 218, 301, 302, 303, 539, 562, 613, 635, 656]);
    for (const c of intervalo(200, 999)) {
      const r = envio(prot(c));
      if (especiais.has(c)) {
        expect(r.classe, `cStat ${c}`).not.toBe("REJEICAO");
      } else {
        expect(r.estadoAlvo, `cStat ${c}`).toBe("REJEITADO");
        expect(r.classe, `cStat ${c}`).toBe("REJEICAO");
      }
    }
  });

  it.each([[1010], [1048], [1072], [1193], [1194], [9999]])(
    "rejeição de 4 dígitos %i (devolução/NTs novas) ⇒ REJEITADO",
    (c) => {
      expect(envio(prot(c))).toMatchObject({ estadoAlvo: "REJEITADO", cStat: c });
    },
  );

  it("TODO 1xx não listado ⇒ DESCONHECIDO/consulta (nunca reuso, nunca renumera)", () => {
    const listados = new Set([100, 103, 104, 105, 108, 109, 110, 150]);
    for (const c of intervalo(100, 199)) {
      if (listados.has(c)) continue;
      expect(envio(prot(c)), `cStat ${c}`).toMatchObject({ classe: "DESCONHECIDO", acao: "CONSULTAR_CHAVE", estadoAlvo: null });
    }
  });

  it.each([[0], [99]])("cStat %i (fora de faixa) ⇒ consulta", (c) => {
    expect(envio(prot(c))).toMatchObject({ acao: "CONSULTAR_CHAVE" });
  });

  it("mensagem traz cStat e xMotivo", () => {
    const r = envio(prot(974, { protXMotivo: "Rejeicao: CNPJ do responsavel tecnico nao autorizado" }));
    expect(r.mensagem).toContain("974");
    expect(r.mensagem).toContain("responsavel tecnico");
  });

  it("xMotivo gigante é truncado", () => {
    const r = envio(prot(225, { protXMotivo: "x".repeat(5000) }));
    expect(r.mensagem.length).toBeLessThan(400);
  });
});

describe("classificarCStatSefaz (régua da evidência B da adoção)", () => {
  it("null ⇒ consulta", () => {
    expect(ok(classificarCStatSefaz(null))).toMatchObject({ acao: "CONSULTAR_CHAVE", estadoAlvo: null });
  });

  it.each([[204], [205], [206], [218], [539], [635], [110], [301], [302], [303], [108], [100]])(
    "%i não é rejeição comum",
    (c) => {
      expect(classificarCStatSefaz(c, { nProt: null }).estadoAlvo).not.toBe("REJEITADO");
    },
  );

  it.each([[225], [974], [999], [656]])("%i é rejeição (estadoAlvo REJEITADO)", (c) => {
    expect(classificarCStatSefaz(c, { nProt: null }).estadoAlvo).toBe("REJEITADO");
  });
});

// ─────────────────────────── B. SEFAZ direto: consulta ───────────────────────────

describe("classificarConsultaSefaz — tabela B", () => {
  it.each([[100], [150]])("%i, chave nossa, digVal null ⇒ AUTORIZADO", (c) => {
    expect(consulta(cons({ cStat: c, chNFe: CHAVE, nProt: "135", digVal: null }))).toMatchObject({
      classe: "AUTORIZADA",
      estadoAlvo: "AUTORIZADO",
      cStat: c,
    });
  });

  it("100, chave nossa, digVal nosso ⇒ AUTORIZADO", () => {
    expect(consulta(cons({ cStat: 100, chNFe: CHAVE, nProt: "135", digVal: ` ${DIGEST} ` }))).toMatchObject({
      estadoAlvo: "AUTORIZADO",
    });
  });

  it("100, chave nossa, digVal de outro conteúdo ⇒ BLOQUEADO", () => {
    expect(consulta(cons({ cStat: 100, chNFe: CHAVE, nProt: "135", digVal: "outroDigest=" }))).toMatchObject({
      classe: "DUPLICIDADE_MESMA_CHAVE",
      estadoAlvo: "BLOQUEADO",
    });
  });

  it("100, chave que não é de nenhuma tentativa ⇒ BLOQUEADO", () => {
    expect(consulta(cons({ cStat: 100, chNFe: CHAVE_OUTRA, nProt: "135" }))).toMatchObject({
      classe: "DUPLICIDADE_OUTRA_CHAVE",
      estadoAlvo: "BLOQUEADO",
    });
  });

  it("100 sem chNFe ⇒ BLOQUEADO (sem prova de propriedade)", () => {
    expect(consulta(cons({ cStat: 100, nProt: "135" }))).toMatchObject({ estadoAlvo: "BLOQUEADO" });
  });

  it("chaves comparadas só pelos dígitos (prefixo NFe tolerado)", () => {
    expect(
      consulta(cons({ cStat: 100, chNFe: `NFe${CHAVE}`, nProt: "135" }), { chavesNossas: [`NFe${CHAVE}`] }),
    ).toMatchObject({ estadoAlvo: "AUTORIZADO" });
  });

  it("100 nosso sem nProt ⇒ inconclusivo", () => {
    expect(consulta(cons({ cStat: 100, chNFe: CHAVE }))).toMatchObject({
      classe: "CONSULTA_INCONCLUSIVA",
      estadoAlvo: "INCERTO",
    });
  });

  it.each([[110], [301], [302], [303]])("%i ⇒ DENEGADO", (c) => {
    expect(consulta(cons({ cStat: c, chNFe: CHAVE }))).toMatchObject({
      classe: "DENEGADA",
      estadoAlvo: "DENEGADO",
      conclusiva: true,
    });
  });

  it.each([[101], [151], [155]])("%i ⇒ BLOQUEADO (cancelada fora do fluxo)", (c) => {
    expect(consulta(cons({ cStat: c, chNFe: CHAVE }))).toMatchObject({
      classe: "CANCELADA_FORA_DO_FLUXO",
      estadoAlvo: "BLOQUEADO",
    });
  });

  it("217 maduro ⇒ NAO_CONSTA (RESERVADO, fecha a tentativa)", () => {
    expect(consulta(cons({ cStat: 217 }), { madura: true })).toMatchObject({
      classe: "NAO_CONSTA",
      estadoAlvo: "RESERVADO",
      acao: "NENHUMA",
      conclusiva: true,
    });
  });

  it("217 imaturo ⇒ inconclusivo (INCERTO)", () => {
    expect(consulta(cons({ cStat: 217 }), { madura: false })).toMatchObject({
      classe: "CONSULTA_INCONCLUSIVA",
      estadoAlvo: "INCERTO",
      conclusiva: false,
    });
  });

  it.each([[105], [204], [539], [999], [225]])("%i ⇒ inconclusivo", (c) => {
    expect(consulta(cons({ cStat: c }), { madura: true })).toMatchObject({
      classe: "CONSULTA_INCONCLUSIVA",
      estadoAlvo: "INCERTO",
      cStat: c,
    });
  });

  it("656 ⇒ inconclusivo com espera", () => {
    expect(consulta(cons({ cStat: 656 }))).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA", retryAposMs: 3_600_000 });
  });

  it.each([["TIMEOUT"], ["REDE"], ["SEM_CREDENCIAL"]] as const)("transporte %s ⇒ inconclusivo, mesmo com 217 maduro", (t) => {
    expect(consulta(cons({ transporte: t, httpStatus: null, cStat: 217 }), { madura: true })).toMatchObject({
      classe: "CONSULTA_INCONCLUSIVA",
    });
  });

  it.each([[500], [403]])("HTTP %i ⇒ inconclusivo, mesmo com 217 maduro", (s) => {
    expect(consulta(cons({ httpStatus: s, cStat: 217 }), { madura: true })).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA" });
  });

  it("sem cStat ⇒ inconclusivo", () => {
    expect(consulta(cons())).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA", cStat: null });
  });

  it("só 217 maduro vale NAO_CONSTA (varredura 0–999)", () => {
    for (const c of intervalo(0, 999)) {
      const r = consulta(cons({ cStat: c, chNFe: CHAVE, nProt: "1" }), { madura: true });
      expect(r.classe === "NAO_CONSTA", `cStat ${c}`).toBe(c === 217);
    }
  });
});

// ─────────────────────────── C. Focus POST ───────────────────────────

describe("classificarPostFocus — tabela C", () => {
  it.each([[200], [201]])("%i autorizado com chave ⇒ AUTORIZADO", (s) => {
    expect(post(focus(s, { status: "autorizado", status_sefaz: "100", chave_nfe: CHAVE, numero: "101", serie: "3" }))).toMatchObject({
      classe: "AUTORIZADA",
      estadoAlvo: "AUTORIZADO",
      cStat: 100,
    });
  });

  it("status em maiúsculas é aceito", () => {
    expect(post(focus(201, { status: "AUTORIZADO", chave_nfe: CHAVE }))).toMatchObject({ estadoAlvo: "AUTORIZADO" });
  });

  it("autorizado sem chave legível ⇒ POLL_REF (read-back precisa da chave)", () => {
    expect(post(focus(201, { status: "autorizado" }))).toMatchObject({ acao: "POLL_REF", estadoAlvo: null });
    expect(post(focus(201, { status: "autorizado", chave_nfe: "123" }))).toMatchObject({ acao: "POLL_REF" });
  });

  it.each([
    [202, { status: "processando_autorizacao" }],
    [201, { status: "processando_autorizacao" }],
    [202, {}],
    [200, { status: "status_novo_desconhecido" }],
  ])("%i %j ⇒ POLL_REF", (s, corpo) => {
    expect(post(focus(s, corpo))).toMatchObject({ classe: "EM_PROCESSAMENTO", acao: "POLL_REF", conclusiva: false });
  });

  it.each([[200], [201], [202]])("%i com corpo ilegível ⇒ GET_REF (incerto)", (s) => {
    expect(post(focus(s, null))).toMatchObject({ classe: "INCERTO_TRANSPORTE", acao: "GET_REF", conclusiva: false });
  });

  describe("erro_autorizacao ⇒ tabela SEFAZ sobre status_sefaz", () => {
    const erro = (status_sefaz: FocusV2Corpo["status_sefaz"], extra: FocusV2Corpo = {}) =>
      post(focus(200, { status: "erro_autorizacao", status_sefaz, mensagem_sefaz: "Rejeicao: motivo", ...extra }));

    it("\"974\" (string) ⇒ REJEITADO com cStat INTEIRO 974", () => {
      const r = erro("974", { mensagem_sefaz: "Rejeicao: CNPJ do Responsavel Tecnico nao autorizado" });
      expect(r).toMatchObject({ classe: "REJEICAO", estadoAlvo: "REJEITADO", cStat: 974, conclusiva: true });
      expect(typeof r.cStat).toBe("number");
      expect(r.mensagem).toContain("Responsavel Tecnico");
    });

    it.each([["225"], [" 704 "], [999], ["781"]])("%j ⇒ REJEITADO", (s) => {
      expect(erro(s)).toMatchObject({ estadoAlvo: "REJEITADO", cStat: normalizarCStat(s) });
    });

    it("status_sefaz null ⇒ REJEITADO (cStat null)", () => {
      expect(erro(null)).toMatchObject({ classe: "REJEICAO", estadoAlvo: "REJEITADO", cStat: null, conclusiva: true });
    });

    it("status_sefaz não numérico ⇒ REJEITADO com codigoProvedor", () => {
      expect(erro("erro_desconhecido")).toMatchObject({
        estadoAlvo: "REJEITADO",
        cStat: null,
        codigoProvedor: "erro_desconhecido",
      });
    });

    it.each([["539"], ["562"], ["613"]])("%s ⇒ RECONCILIAR_539 com a chave da mensagem", (s) => {
      expect(erro(s, { mensagem_sefaz: `Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe:${CHAVE_OUTRA}]` })).toMatchObject({
        classe: "DUPLICIDADE_OUTRA_CHAVE",
        acao: "RECONCILIAR_539",
        chaveReferida: CHAVE_OUTRA,
        conclusiva: true,
      });
    });

    it("539 com chave além do truncamento da mensagem ainda é lida", () => {
      expect(erro("539", { mensagem_sefaz: `${"x".repeat(600)} [chNFe:${CHAVE_OUTRA}]` }).chaveReferida).toBe(CHAVE_OUTRA);
    });

    it.each([["204"], ["205"], ["218"], ["150"], ["199"]])("%s ⇒ consulta pela referência (GET_REF)", (s) => {
      expect(erro(s)).toMatchObject({ acao: "GET_REF", estadoAlvo: null });
    });

    it("100 dentro de erro é contraditório ⇒ GET_REF, nunca AUTORIZADO", () => {
      expect(erro("100", { protocolo: "135" })).toMatchObject({ classe: "DESCONHECIDO", acao: "GET_REF", estadoAlvo: null });
    });

    it("110 sem protocolo ⇒ GET_REF; com protocolo ⇒ DENEGADO", () => {
      expect(erro("110")).toMatchObject({ classe: "DENEGACAO_A_CONFIRMAR", acao: "GET_REF" });
      expect(erro("110", { protocolo: "135260000000009" })).toMatchObject({ estadoAlvo: "DENEGADO" });
    });

    it("206 ⇒ INUTILIZADO", () => {
      expect(erro("206")).toMatchObject({ estadoAlvo: "INUTILIZADO", acao: "NENHUMA" });
    });

    it.each([["108"], ["109"]])("%s ⇒ RESERVADO conclusivo", (s) => {
      expect(erro(s)).toMatchObject({ estadoAlvo: "RESERVADO", conclusiva: true });
    });

    it("635 ⇒ INCERTO", () => {
      expect(erro("635")).toMatchObject({ estadoAlvo: "INCERTO", acao: "NENHUMA", conclusiva: false });
    });

    it("656 ⇒ REJEITADO + espera", () => {
      expect(erro("656")).toMatchObject({ estadoAlvo: "REJEITADO", retryAposMs: 3_600_000 });
    });

    it.each([["103"], ["104"], ["105"]])("%s ⇒ POLL_REF", (s) => {
      expect(erro(s)).toMatchObject({ acao: "POLL_REF" });
    });
  });

  it("denegado ⇒ DENEGADO", () => {
    expect(post(focus(200, { status: "denegado", status_sefaz: "302" }))).toMatchObject({
      classe: "DENEGADA",
      estadoAlvo: "DENEGADO",
      cStat: 302,
      conclusiva: true,
    });
  });

  it("cancelado no POST ⇒ GET_REF", () => {
    expect(post(focus(200, { status: "cancelado" }))).toMatchObject({ acao: "GET_REF", estadoAlvo: null });
  });

  it.each([
    [400, { codigo: "requisicao_invalida", mensagem: "Parâmetro inválido" }],
    [400, { codigo: "empresa_nao_habilitada", mensagem: "Empresa não habilitada" }],
    [400, { codigo: "outro_400" }],
    [401, null],
    [401, { codigo: "acesso_negado" }],
    [403, { codigo: "permissao_negada" }],
    [403, null],
    [404, { codigo: "nao_encontrado" }],
    [404, null],
    [415, null],
    [422, { codigo: "permissao_negada", mensagem: "Sem permissão" }],
    [422, { codigo: "erro_validacao_schema", mensagem: "Erro de schema" }],
  ] as Array<[number, FocusV2Corpo | null]>)("%i %j ⇒ PRE_ENVIO_PROVEDOR (RESERVADO conclusivo, mesma ref)", (s, corpo) => {
    expect(post(focus(s, corpo))).toMatchObject({
      classe: "PRE_ENVIO_PROVEDOR",
      estadoAlvo: "RESERVADO",
      acao: "NENHUMA",
      conclusiva: true,
      cStat: null,
    });
  });

  it("422 erro_validacao_schema leva codigoProvedor e os erros de campo na mensagem", () => {
    const r = post(
      focus(422, {
        codigo: "erro_validacao_schema",
        mensagem: "Erro de validação",
        erros: [{ campo: "items[0].codigo_ncm", mensagem: "NCM inválido" }, { mensagem: "CFOP inválido" }],
      }),
    );
    expect(r.codigoProvedor).toBe("erro_validacao_schema");
    expect(r.mensagem).toContain("items[0].codigo_ncm: NCM inválido");
    expect(r.mensagem).toContain("CFOP inválido");
  });

  it("401 HTML ⇒ mensagem de token, sem vazar o corpo", () => {
    const r = post(focus(401, null));
    expect(r.mensagem).toContain("Token do Focus inválido");
    expect(r.codigoProvedor).toBeNull();
  });

  it("429 ⇒ RATE_LIMIT RESERVADO + Retry-After", () => {
    expect(post(focus(429, null, { retryAfterMs: 5_000 }))).toMatchObject({
      classe: "RATE_LIMIT",
      estadoAlvo: "RESERVADO",
      conclusiva: true,
      retryAposMs: 5_000,
    });
    expect(post(focus(429, null))).toMatchObject({ retryAposMs: 60_000 });
    expect(post(focus(429, null, { retryAfterMs: 0 }))).toMatchObject({ retryAposMs: 60_000 });
    expect(classificarPostFocus(focus(429, null), { rateLimitPadraoMs: 7_000 }).retryAposMs).toBe(7_000);
  });

  it.each([["pending_operation"], ["em_processamento"]])("422 %s ⇒ GET_REF (incerto)", (codigo) => {
    expect(post(focus(422, { codigo }))).toMatchObject({
      classe: "EM_PROCESSAMENTO",
      estadoAlvo: null,
      acao: "GET_REF",
      conclusiva: false,
      codigoProvedor: codigo,
    });
  });

  it.each([["already_processed"], ["nfe_autorizada"]])("422 %s ⇒ GET_REF", (codigo) => {
    expect(post(focus(422, { codigo }))).toMatchObject({ acao: "GET_REF", conclusiva: false, estadoAlvo: null });
  });

  it("422 com status_sefaz numérico ⇒ tabela SEFAZ", () => {
    expect(post(focus(422, { codigo: "erro_autorizacao_sefaz", status_sefaz: "974" }))).toMatchObject({
      estadoAlvo: "REJEITADO",
      cStat: 974,
      codigoProvedor: "erro_autorizacao_sefaz",
    });
    expect(post(focus(422, { codigo: "x", status_sefaz: "539" }))).toMatchObject({ acao: "RECONCILIAR_539" });
  });

  it("422 com código desconhecido ⇒ GET_REF conclusivo (404 posterior vale na hora)", () => {
    expect(post(focus(422, { codigo: "codigo_novo", mensagem: "?" }))).toMatchObject({
      classe: "DESCONHECIDO",
      estadoAlvo: null,
      acao: "GET_REF",
      conclusiva: true,
      codigoProvedor: "codigo_novo",
    });
    expect(post(focus(422, {}))).toMatchObject({ acao: "GET_REF", conclusiva: true });
  });

  it("422 com corpo ilegível ⇒ GET_REF não conclusivo", () => {
    expect(post(focus(422, null))).toMatchObject({ classe: "INCERTO_TRANSPORTE", acao: "GET_REF", conclusiva: false });
  });

  it.each([[500], [502], [503], [504]])("HTTP %i ⇒ GET_REF (incerto)", (s) => {
    expect(post(focus(s, { status: "erro" }))).toMatchObject({
      classe: "INCERTO_TRANSPORTE",
      acao: "GET_REF",
      conclusiva: false,
    });
  });

  it.each([["TIMEOUT"], ["REDE"], ["SEM_CREDENCIAL"]] as const)("transporte %s ⇒ GET_REF (incerto)", (t) => {
    expect(post(focus(null, null, { transporte: t }))).toMatchObject({ classe: "INCERTO_TRANSPORTE", acao: "GET_REF" });
  });

  it("sem status HTTP ⇒ GET_REF", () => {
    expect(post(focus(null, { status: "autorizado", chave_nfe: CHAVE }))).toMatchObject({ acao: "GET_REF" });
  });

  it.each([[408], [409], [405], [302], [100]])("HTTP %i sem prova de recusa ⇒ GET_REF não conclusivo", (s) => {
    expect(post(focus(s, null))).toMatchObject({ acao: "GET_REF", conclusiva: false });
  });

  it("mensagem nunca carrega campos que não sejam de motivo", () => {
    const r = post(
      focus(422, {
        codigo: "erro_validacao_schema",
        mensagem: "Erro",
        caminho_xml_nota_fiscal: "/arquivos/segredo.xml",
      } as FocusV2Corpo),
    );
    expect(r.mensagem).not.toContain("segredo");
  });
});

// ─────────────────────────── D. Focus GET ───────────────────────────

describe("classificarGetFocus — tabela D", () => {
  it("200 autorizado com chave ⇒ AUTORIZADO", () => {
    expect(get(focus(200, { status: "autorizado", chave_nfe: CHAVE, status_sefaz: "100" }))).toMatchObject({
      classe: "AUTORIZADA",
      estadoAlvo: "AUTORIZADO",
      cStat: 100,
    });
  });

  it("autorizado sem chave ⇒ inconclusivo", () => {
    expect(get(focus(200, { status: "autorizado" }))).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA", estadoAlvo: "INCERTO" });
  });

  it("cancelado ⇒ BLOQUEADO", () => {
    expect(get(focus(200, { status: "cancelado" }))).toMatchObject({
      classe: "CANCELADA_FORA_DO_FLUXO",
      estadoAlvo: "BLOQUEADO",
    });
  });

  it("denegado ⇒ DENEGADO", () => {
    expect(get(focus(200, { status: "denegado", status_sefaz: "110" }))).toMatchObject({
      estadoAlvo: "DENEGADO",
      cStat: 110,
      conclusiva: true,
    });
  });

  describe("erro_autorizacao", () => {
    const erro = (status_sefaz: FocusV2Corpo["status_sefaz"], extra: FocusV2Corpo = {}) =>
      get(focus(200, { status: "erro_autorizacao", status_sefaz, mensagem_sefaz: "Rejeicao", ...extra }));

    it.each([["539"], ["562"], ["613"]])("%s ⇒ RECONCILIAR_539", (s) => {
      expect(erro(s, { mensagem_sefaz: `Duplicidade [chNFe:${CHAVE_OUTRA}]` })).toMatchObject({
        classe: "DUPLICIDADE_OUTRA_CHAVE",
        estadoAlvo: null,
        acao: "RECONCILIAR_539",
        chaveReferida: CHAVE_OUTRA,
      });
    });

    it("205 ⇒ CONSUMIDO_EXTERNO", () => {
      expect(erro("205")).toMatchObject({ estadoAlvo: "CONSUMIDO_EXTERNO", conclusiva: true });
    });

    it("206 ⇒ INUTILIZADO", () => {
      expect(erro("206")).toMatchObject({ estadoAlvo: "INUTILIZADO" });
    });

    it.each([["108"], ["109"]])("%s ⇒ RESERVADO", (s) => {
      expect(erro(s)).toMatchObject({ estadoAlvo: "RESERVADO", conclusiva: true });
    });

    it("635 ⇒ INCERTO", () => {
      expect(erro("635")).toMatchObject({ estadoAlvo: "INCERTO", conclusiva: false });
    });

    it("656 ⇒ REJEITADO + espera", () => {
      expect(erro("656")).toMatchObject({ estadoAlvo: "REJEITADO", retryAposMs: 3_600_000 });
    });

    it.each([["974"], ["225"], ["999"], [215], ["1010"]])("%j ⇒ REJEITADO com cStat inteiro", (s) => {
      expect(erro(s)).toMatchObject({ classe: "REJEICAO", estadoAlvo: "REJEITADO", cStat: normalizarCStat(s), conclusiva: true });
    });

    it.each([[null], [undefined], ["abc"], ["0"]])("status_sefaz %j ⇒ REJEITADO", (s) => {
      expect(erro(s)).toMatchObject({ estadoAlvo: "REJEITADO", conclusiva: true });
    });

    it("110 sem protocolo ⇒ REJEITADO (reenvio devolve 205 se a denegação existir); com protocolo ⇒ DENEGADO", () => {
      expect(erro("110")).toMatchObject({ estadoAlvo: "REJEITADO" });
      expect(erro("110", { protocolo_sefaz: "135" })).toMatchObject({ estadoAlvo: "DENEGADO" });
    });

    it.each([["204"], ["218"]])("%s ⇒ BLOQUEADO (nunca reuso às cegas)", (s) => {
      expect(erro(s)).toMatchObject({ estadoAlvo: "BLOQUEADO", acao: "NENHUMA" });
    });

    it.each([["100"], ["103"], ["150"]])("%s contraditório ⇒ inconclusivo", (s) => {
      expect(erro(s)).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA", estadoAlvo: "INCERTO" });
    });
  });

  it.each([[{ status: "processando_autorizacao" }], [{ status: "novo" }], [{}]])("%j ⇒ inconclusivo", (corpo) => {
    expect(get(focus(200, corpo), { madura: true, postConclusivo: true })).toMatchObject({
      classe: "CONSULTA_INCONCLUSIVA",
      estadoAlvo: "INCERTO",
    });
  });

  describe("404", () => {
    const nao = focus(404, { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" });

    it("maduro ⇒ NAO_CONSTA (RESERVADO, conclusivo)", () => {
      expect(get(nao, { madura: true })).toMatchObject({
        classe: "NAO_CONSTA",
        estadoAlvo: "RESERVADO",
        conclusiva: true,
      });
    });

    it("POST conclusivo ⇒ NAO_CONSTA na hora", () => {
      expect(get(nao, { postConclusivo: true })).toMatchObject({ classe: "NAO_CONSTA" });
    });

    it("imaturo ⇒ inconclusivo", () => {
      expect(get(nao)).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA", estadoAlvo: "INCERTO" });
    });

    it("JSON sem codigo, maduro ⇒ NAO_CONSTA", () => {
      expect(get(focus(404, {}), { madura: true })).toMatchObject({ classe: "NAO_CONSTA" });
    });

    it("HTML (corpo ilegível) ⇒ inconclusivo mesmo maduro", () => {
      expect(get(focus(404, null), { madura: true, postConclusivo: true })).toMatchObject({
        classe: "CONSULTA_INCONCLUSIVA",
      });
    });

    it("codigo diferente de nao_encontrado ⇒ inconclusivo mesmo maduro", () => {
      expect(get(focus(404, { codigo: "rota_inexistente" }), { madura: true })).toMatchObject({
        classe: "CONSULTA_INCONCLUSIVA",
      });
    });
  });

  it.each([[401], [403], [429], [500], [502], [503], [400], [422], [302]])(
    "HTTP %i ⇒ inconclusivo, NUNCA não consta (mesmo maduro)",
    (s) => {
      const r = get(focus(s, { codigo: "nao_encontrado" }), { madura: true, postConclusivo: true });
      expect(r.classe).toBe("CONSULTA_INCONCLUSIVA");
      expect(r.estadoAlvo).toBe("INCERTO");
    },
  );

  it("429 ⇒ inconclusivo com Retry-After", () => {
    expect(get(focus(429, null, { retryAfterMs: 9_000 }))).toMatchObject({ retryAposMs: 9_000 });
  });

  it.each([["TIMEOUT"], ["REDE"], ["SEM_CREDENCIAL"]] as const)("transporte %s ⇒ inconclusivo", (t) => {
    expect(get(focus(null, null, { transporte: t }), { madura: true, postConclusivo: true })).toMatchObject({
      classe: "CONSULTA_INCONCLUSIVA",
    });
  });

  it("sem status HTTP ou corpo 2xx ilegível ⇒ inconclusivo", () => {
    expect(get(focus(null, null), { madura: true })).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA" });
    expect(get(focus(200, null), { madura: true })).toMatchObject({ classe: "CONSULTA_INCONCLUSIVA" });
  });
});
