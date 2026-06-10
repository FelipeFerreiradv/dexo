import { describe, it, expect, beforeEach } from "vitest";
import type {
  INfeProvider,
  NfeProviderEmitResult,
  NfeProviderConsultaResult,
  NfeProviderCancelResult,
  NfeProviderInutilizacaoResult,
} from "../../app/fiscal/providers/nfe-provider.interface";
import { FocusNfeProvider } from "../../app/fiscal/providers/focus-nfe.provider";
import {
  createNfeProvider,
  createNfeProviderFromConfig,
} from "../../app/fiscal/providers/provider-factory";
import { SefazDirectProvider } from "../../app/fiscal/providers/sefaz-direct.provider";
import { parsePfx } from "../../app/fiscal/certificate/certificate-loader.service";
import { MockNfeProvider, NfeProviderResults } from "./__mocks__/mock-nfe-provider";
import { generateTestCertificate } from "./__helpers__/test-certificate";

/**
 * Contract suite — every implementation of INfeProvider must satisfy this.
 *
 * Validates shape (method existence + return type structure) without hitting
 * the network. Real SEFAZ behavior is exercised in integration suites that
 * gate on env flags.
 */

const requiredKeys = ["name", "emitir", "consultar", "cancelar", "inutilizar"] as const;

function assertShape(provider: INfeProvider, name: string): void {
  expect(provider.name, `${name}.name`).toBeTypeOf("string");
  expect(provider.name.length, `${name}.name length > 0`).toBeGreaterThan(0);
  for (const key of requiredKeys) {
    if (key === "name") continue;
    expect(typeof (provider as any)[key], `${name}.${key} is function`).toBe(
      "function",
    );
  }
}

describe("INfeProvider contract — shape", () => {
  it("FocusNfeProvider satisfies the contract", () => {
    const provider = new FocusNfeProvider("homologacao");
    assertShape(provider, "FocusNfeProvider");
    expect(provider.name).toBe("FOCUS_NFE");
  });

  it("MockNfeProvider satisfies the contract", () => {
    const provider = new MockNfeProvider();
    assertShape(provider, "MockNfeProvider");
    expect(provider.name).toBe("MOCK");
  });

  it("factory returns Focus by default and for FOCUS_NFE", () => {
    const fallback = createNfeProvider(null, "HOMOLOGACAO");
    const focus = createNfeProvider("FOCUS_NFE", "HOMOLOGACAO");
    const focusProd = createNfeProvider("FOCUS_NFE", "PRODUCAO");

    expect(fallback.name).toBe("FOCUS_NFE");
    expect(focus.name).toBe("FOCUS_NFE");
    expect(focusProd.name).toBe("FOCUS_NFE");
  });

  it("factory compacta rejeita SEFAZ_DIRECT com mensagem clara", () => {
    expect(() => createNfeProvider("SEFAZ_DIRECT", "HOMOLOGACAO")).toThrow(
      /createNfeProviderFromConfig/,
    );
  });

  it("SefazDirectProvider satisfies the contract", () => {
    const tc = generateTestCertificate();
    const certificate = parsePfx(tc.pfxBuffer, tc.password);
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate,
    });
    assertShape(provider, "SefazDirectProvider");
    expect(provider.name).toBe("SEFAZ_DIRECT");
    // Optional method present
    expect(typeof provider.consultarStatusServico).toBe("function");
  });
});

describe("createNfeProviderFromConfig — async resolver", () => {
  it("delega para createNfeProvider quando provider e FOCUS_NFE", async () => {
    const provider = await createNfeProviderFromConfig({
      providerName: "FOCUS_NFE",
      ambiente: "HOMOLOGACAO",
    });
    expect(provider.name).toBe("FOCUS_NFE");
  });

  it("usa Focus como fallback quando providerName nulo", async () => {
    const provider = await createNfeProviderFromConfig({
      providerName: null,
      ambiente: "HOMOLOGACAO",
    });
    expect(provider.name).toBe("FOCUS_NFE");
  });

  it("rejeita SEFAZ_DIRECT sem uf", async () => {
    await expect(
      createNfeProviderFromConfig({
        providerName: "SEFAZ_DIRECT",
        ambiente: "HOMOLOGACAO",
        certificadoPath: "/x.pfx",
        certificadoSenhaEnc: "x:y:z",
      }),
    ).rejects.toThrow(/uf/);
  });

  it("rejeita SEFAZ_DIRECT sem certificadoPath", async () => {
    await expect(
      createNfeProviderFromConfig({
        providerName: "SEFAZ_DIRECT",
        ambiente: "HOMOLOGACAO",
        uf: "SP",
        certificadoSenhaEnc: "x:y:z",
      }),
    ).rejects.toThrow(/certificadoPath/);
  });

  it("rejeita SEFAZ_DIRECT sem certificadoSenhaEnc", async () => {
    await expect(
      createNfeProviderFromConfig({
        providerName: "SEFAZ_DIRECT",
        ambiente: "HOMOLOGACAO",
        uf: "SP",
        certificadoPath: "/x.pfx",
      }),
    ).rejects.toThrow(/certificadoSenhaEnc/);
  });
});

describe("INfeProvider contract — return shape (via MockNfeProvider)", () => {
  let provider: MockNfeProvider;

  beforeEach(() => {
    provider = new MockNfeProvider();
  });

  it("emitir() returns NfeProviderEmitResult with all required fields", async () => {
    const result = await provider.emitir({
      nfeData: { dummy: true },
      token: "tok",
      ref: "ref-1",
    });

    expectEmitResult(result);
    expect(result.success).toBe(true);
    expect(result.status).toBe("autorizada");
    expect(result.chaveAcesso).toMatch(/^\d{44}$/);
    expect(provider.emitCalls).toHaveLength(1);
    expect(provider.emitCalls[0].input.ref).toBe("ref-1");
  });

  it("consultar() returns NfeProviderConsultaResult with all required fields", async () => {
    const result = await provider.consultar("ref-1", "tok");

    expectConsultaResult(result);
    expect(result.status).toBe("autorizada");
    expect(provider.consultaCalls).toHaveLength(1);
    expect(provider.consultaCalls[0].input).toEqual({ ref: "ref-1", token: "tok" });
  });

  it("cancelar() returns NfeProviderCancelResult with all required fields", async () => {
    const result = await provider.cancelar({
      ref: "ref-1",
      chaveAcesso: "35260400000000000100550010000000011000000017",
      protocolo: "135260000000001",
      justificativa: "Cancelamento de teste com justificativa adequada",
      token: "tok",
    });

    expectCancelResult(result);
    expect(result.success).toBe(true);
    expect(provider.cancelCalls).toHaveLength(1);
  });

  it("inutilizar() returns NfeProviderInutilizacaoResult with all required fields", async () => {
    const result = await provider.inutilizar({
      cnpj: "00000000000100",
      serie: 1,
      numeroInicial: 10,
      numeroFinal: 12,
      justificativa: "Inutilizacao por teste contratual valida",
      token: "tok",
      ambiente: "homologacao",
    });

    expectInutilizaResult(result);
    expect(result.success).toBe(true);
    expect(provider.inutilizaCalls).toHaveLength(1);
  });
});

describe("MockNfeProvider — queue semantics", () => {
  it("delivers queued results in order, then falls back to default", async () => {
    const provider = new MockNfeProvider();
    provider
      .queueEmit(NfeProviderResults.emitProcessando())
      .queueEmit(NfeProviderResults.emitRejeitada());

    const first = await provider.emitir({ nfeData: {}, token: "", ref: "r1" });
    const second = await provider.emitir({ nfeData: {}, token: "", ref: "r2" });
    const third = await provider.emitir({ nfeData: {}, token: "", ref: "r3" });

    expect(first.status).toBe("processando");
    expect(second.status).toBe("rejeitada");
    expect(third.status).toBe("autorizada");
    expect(provider.emitCalls).toHaveLength(3);
  });

  it("throws when an Error is queued", async () => {
    const provider = new MockNfeProvider();
    provider.queueEmit(new Error("boom"));

    await expect(
      provider.emitir({ nfeData: {}, token: "", ref: "r" }),
    ).rejects.toThrow("boom");
  });

  it("reset() clears queues and call logs", async () => {
    const provider = new MockNfeProvider();
    provider.queueEmit(NfeProviderResults.emitAutorizada());
    await provider.emitir({ nfeData: {}, token: "", ref: "r" });

    expect(provider.emitCalls).toHaveLength(1);
    provider.reset();
    expect(provider.emitCalls).toHaveLength(0);
  });

  it("supports polling pattern: processando then autorizada via consulta queue", async () => {
    const provider = new MockNfeProvider();
    provider.queueEmit(NfeProviderResults.emitProcessando());
    provider.queueConsulta({
      status: "processando",
      chaveAcesso: null,
      protocolo: null,
      dataAutorizacao: null,
      codigoStatus: 105,
      mensagem: "Em processamento",
      xmlAutorizado: null,
    });
    provider.queueConsulta(NfeProviderResults.consultaAutorizada("r"));

    const emit = await provider.emitir({ nfeData: {}, token: "", ref: "r" });
    expect(emit.status).toBe("processando");

    const poll1 = await provider.consultar("r", "");
    expect(poll1.status).toBe("processando");

    const poll2 = await provider.consultar("r", "");
    expect(poll2.status).toBe("autorizada");
    expect(poll2.chaveAcesso).toMatch(/^\d{44}$/);
  });
});

// ── Type-shape assertions ──

function expectEmitResult(r: NfeProviderEmitResult): void {
  expect(r).toHaveProperty("success");
  expect(r).toHaveProperty("chaveAcesso");
  expect(r).toHaveProperty("protocolo");
  expect(r).toHaveProperty("dataAutorizacao");
  expect(r).toHaveProperty("status");
  expect(r).toHaveProperty("codigoStatus");
  expect(r).toHaveProperty("mensagem");
  expect(r).toHaveProperty("xmlAutorizado");
  expect(r).toHaveProperty("providerRef");
  expect(["autorizada", "rejeitada", "processando", "erro"]).toContain(r.status);
}

function expectConsultaResult(r: NfeProviderConsultaResult): void {
  expect(r).toHaveProperty("status");
  expect(r).toHaveProperty("chaveAcesso");
  expect(r).toHaveProperty("protocolo");
  expect(r).toHaveProperty("dataAutorizacao");
  expect(r).toHaveProperty("codigoStatus");
  expect(r).toHaveProperty("mensagem");
  expect(r).toHaveProperty("xmlAutorizado");
  expect(["autorizada", "rejeitada", "processando", "cancelada", "erro"]).toContain(
    r.status,
  );
}

function expectCancelResult(r: NfeProviderCancelResult): void {
  expect(r).toHaveProperty("success");
  expect(r).toHaveProperty("protocolo");
  expect(r).toHaveProperty("mensagem");
  expect(typeof r.success).toBe("boolean");
}

function expectInutilizaResult(r: NfeProviderInutilizacaoResult): void {
  expect(r).toHaveProperty("success");
  expect(r).toHaveProperty("protocolo");
  expect(r).toHaveProperty("mensagem");
  expect(typeof r.success).toBe("boolean");
}
