import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  shouldFallbackToSvc,
  getSvcType,
  getTpEmisForSvc,
  isAutoFallbackEnabled,
} from "../../../app/fiscal/sefaz/contingencia.service";
import type { NfeProviderEmitResult } from "../../../app/fiscal/providers/nfe-provider.interface";

function makeResult(
  overrides: Partial<NfeProviderEmitResult> = {},
): NfeProviderEmitResult {
  return {
    success: false,
    chaveAcesso: null,
    protocolo: null,
    dataAutorizacao: null,
    status: "erro",
    codigoStatus: null,
    mensagem: "",
    xmlAutorizado: null,
    providerRef: null,
    ...overrides,
  };
}

describe("shouldFallbackToSvc — sucesso explicito", () => {
  it("nao faz fallback quando emissao foi autorizada", () => {
    const r = makeResult({
      success: true,
      status: "autorizada",
      codigoStatus: 100,
    });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(false);
  });

  it("nao faz fallback quando esta processando (assincrono pendente)", () => {
    const r = makeResult({
      success: true,
      status: "processando",
      codigoStatus: 103,
    });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(false);
  });
});

describe("shouldFallbackToSvc — falha de infra → fallback", () => {
  it("cai pra SVC quando cStat=108 (servico paralisado curto)", () => {
    const r = makeResult({ status: "rejeitada", codigoStatus: 108 });
    const d = shouldFallbackToSvc(r);
    expect(d.shouldFallback).toBe(true);
    expect(d.reason).toMatch(/108/);
  });

  it("cai pra SVC quando cStat=109 (servico paralisado sem previsao)", () => {
    const r = makeResult({ status: "rejeitada", codigoStatus: 109 });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(true);
  });

  it("cai pra SVC para familia 280-289 (erro de comunicacao SEFAZ)", () => {
    for (const cStat of [280, 285, 289]) {
      const r = makeResult({ status: "rejeitada", codigoStatus: cStat });
      expect(shouldFallbackToSvc(r).shouldFallback, `cStat=${cStat}`).toBe(true);
    }
  });

  it("cai pra SVC quando status=erro (rede / HTTP 5xx persistente)", () => {
    const r = makeResult({
      status: "erro",
      codigoStatus: null,
      mensagem: "ETIMEDOUT apos retry",
    });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(true);
  });
});

describe("shouldFallbackToSvc — rejeicao comum → NAO fallback", () => {
  it("nao cai pra SVC em cStat=225 (falha schema XML)", () => {
    const r = makeResult({ status: "rejeitada", codigoStatus: 225 });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(false);
  });

  it("nao cai pra SVC em cStat=539 (duplicidade)", () => {
    const r = makeResult({ status: "rejeitada", codigoStatus: 539 });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(false);
  });

  it("nao cai pra SVC em cStat=110 (denegada)", () => {
    const r = makeResult({ status: "rejeitada", codigoStatus: 110 });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(false);
  });

  it("nao cai pra SVC em cStat=217 (nao consta)", () => {
    const r = makeResult({ status: "rejeitada", codigoStatus: 217 });
    expect(shouldFallbackToSvc(r).shouldFallback).toBe(false);
  });
});

describe("getSvcType — UF → SVC primario", () => {
  it("UFs SVC_AN: SP, MG, RJ, etc.", () => {
    expect(getSvcType("SP")).toBe("SVC_AN");
    expect(getSvcType("MG")).toBe("SVC_AN");
    expect(getSvcType("RJ")).toBe("SVC_AN");
    expect(getSvcType("SC")).toBe("SVC_AN");
    expect(getSvcType("DF")).toBe("SVC_AN");
  });

  it("UFs SVC_RS: RS, PR, MT, MS, BA, GO, PE, AM, MA", () => {
    expect(getSvcType("RS")).toBe("SVC_RS");
    expect(getSvcType("PR")).toBe("SVC_RS");
    expect(getSvcType("MT")).toBe("SVC_RS");
    expect(getSvcType("BA")).toBe("SVC_RS");
    expect(getSvcType("GO")).toBe("SVC_RS");
  });
});

describe("getTpEmisForSvc", () => {
  it("SVC_AN → tpEmis 6", () => {
    expect(getTpEmisForSvc("SVC_AN")).toBe(6);
  });

  it("SVC_RS → tpEmis 7", () => {
    expect(getTpEmisForSvc("SVC_RS")).toBe(7);
  });
});

describe("isAutoFallbackEnabled", () => {
  const original = process.env.SEFAZ_AUTO_FALLBACK_ENABLED;

  beforeEach(() => {
    delete process.env.SEFAZ_AUTO_FALLBACK_ENABLED;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SEFAZ_AUTO_FALLBACK_ENABLED;
    } else {
      process.env.SEFAZ_AUTO_FALLBACK_ENABLED = original;
    }
  });

  it("default false quando env nao setada", () => {
    expect(isAutoFallbackEnabled()).toBe(false);
  });

  it("true apenas quando env = 'true' literal", () => {
    process.env.SEFAZ_AUTO_FALLBACK_ENABLED = "true";
    expect(isAutoFallbackEnabled()).toBe(true);
  });

  it("false para 'false', '1', vazia etc", () => {
    process.env.SEFAZ_AUTO_FALLBACK_ENABLED = "false";
    expect(isAutoFallbackEnabled()).toBe(false);

    process.env.SEFAZ_AUTO_FALLBACK_ENABLED = "1";
    expect(isAutoFallbackEnabled()).toBe(false);

    process.env.SEFAZ_AUTO_FALLBACK_ENABLED = "";
    expect(isAutoFallbackEnabled()).toBe(false);
  });
});
