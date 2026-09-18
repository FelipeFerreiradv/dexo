import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMPOS_LOG_NUMERACAO,
  PREFIXO_LOG_NUMERACAO,
  camposLogNumeracao,
  logNumeracao,
} from "../../../app/fiscal/numeracao/log";

// Lista branca do log `[nfe-numeracao]`: segredo nunca chega ao console.

function capturar(nivel: "info" | "warn" | "error") {
  return vi.spyOn(console, nivel).mockImplementation(() => undefined);
}

function linhaJson(spy: ReturnType<typeof capturar>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const [prefixo, json] = spy.mock.calls[0] as [string, string];
  expect(prefixo).toBe("[nfe-numeracao]");
  expect(typeof json).toBe("string");
  return JSON.parse(json);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logNumeracao", () => {
  it("prefixo fixo, evento primeiro e nível info por padrão", () => {
    const info = capturar("info");
    logNumeracao("nfe.numeracao.reservado", { nfeId: "n1", numero: 101, origem: "CONTADOR" });
    const saida = linhaJson(info);
    expect(Object.keys(saida)[0]).toBe("evento");
    expect(saida).toEqual({ evento: "nfe.numeracao.reservado", nfeId: "n1", numero: 101, origem: "CONTADOR" });
    expect(PREFIXO_LOG_NUMERACAO).toBe("[nfe-numeracao]");
  });

  it.each([["warn"], ["error"]] as Array<["warn" | "error"]>)("nível %s usa console.%s", (nivel) => {
    const spy = capturar(nivel);
    const info = capturar("info");
    logNumeracao("nfe.numeracao.x", { numero: 1 }, nivel);
    expect(linhaJson(spy)).toMatchObject({ evento: "nfe.numeracao.x", numero: 1 });
    expect(info).not.toHaveBeenCalled();
  });

  it("nível inválido em runtime cai para info", () => {
    const info = capturar("info");
    logNumeracao("e", {}, "debug" as unknown as "info");
    expect(linhaJson(info)).toEqual({ evento: "e" });
  });

  it("a lista branca é exatamente a do design (+ classe e estado)", () => {
    expect([...CAMPOS_LOG_NUMERACAO].sort()).toEqual(
      [
        "userId",
        "nfeId",
        "cfcId",
        "ambiente",
        "modelo",
        "serie",
        "numero",
        "reservaId",
        "tentativa",
        "de",
        "para",
        "origem",
        "provedor",
        "cStat",
        "codigoProvedor",
        "chaveSufixo",
        "latenciaMs",
        "lockEsperaMs",
        "motivo",
        "classe",
        "estado",
      ].sort(),
    );
  });

  it("todos os campos da lista branca passam", () => {
    const info = capturar("info");
    const campos = Object.fromEntries(CAMPOS_LOG_NUMERACAO.map((c, i) => [c, c === "chaveSufixo" ? "1234567890" : `v${i}`]));
    logNumeracao("todos", campos);
    expect(linhaJson(info)).toEqual({ evento: "todos", ...campos });
  });

  it("token, senha, CSRT, CSC, XML, certificado e destinatário NUNCA são impressos", () => {
    const info = capturar("info");
    const segredos = {
      token: "TOKEN-SECRETO-123",
      providerToken: "TOKEN-SECRETO-123",
      Authorization: "Basic VE9LRU4tU0VDUkVUTy0xMjM6",
      senha: "SENHA-CERT-XYZ",
      certificadoSenhaEnc: "SENHA-CERT-XYZ",
      csrt: "CSRT-SEGREDO-999",
      csrtToken: "CSRT-SEGREDO-999",
      hashCSRT: "CSRT-SEGREDO-999",
      csc: "CSC-SEGREDO",
      xml: "<NFe><infNFe>DESTINATARIO-FULANO</infNFe></NFe>",
      signedXml: "<Signature>ASSINATURA</Signature>",
      destinatario: { nome: "DESTINATARIO-FULANO", cpf: "12345678909" },
      chaveAcesso: "41260911386276000176550030000001011123456780",
      config: { providerToken: "TOKEN-SECRETO-123" },
    };
    logNumeracao("nfe.numeracao.resultado", { ...segredos, nfeId: "n1", cStat: 974 });
    const [, json] = info.mock.calls[0] as [string, string];
    for (const segredo of [
      "TOKEN-SECRETO-123",
      "VE9LRU4",
      "SENHA-CERT-XYZ",
      "CSRT-SEGREDO-999",
      "CSC-SEGREDO",
      "DESTINATARIO-FULANO",
      "ASSINATURA",
      "12345678909",
      "41260911386276000176550030000001011123456780",
    ]) {
      expect(json).not.toContain(segredo);
    }
    expect(JSON.parse(json)).toEqual({ evento: "nfe.numeracao.resultado", nfeId: "n1", cStat: 974 });
  });

  it("valor não primitivo num campo permitido é descartado (sem vazar objeto aninhado)", () => {
    const info = capturar("info");
    logNumeracao("e", {
      motivo: { token: "TOKEN-SECRETO-123" },
      de: ["TOKEN-SECRETO-123"],
      para: () => "x",
      numero: 5,
    });
    const [, json] = info.mock.calls[0] as [string, string];
    expect(json).not.toContain("TOKEN-SECRETO-123");
    expect(JSON.parse(json)).toEqual({ evento: "e", numero: 5 });
  });

  it("chaveSufixo imprime só os 10 últimos caracteres", () => {
    const info = capturar("info");
    logNumeracao("e", { chaveSufixo: "41260911386276000176550030000001011123456780" });
    expect(linhaJson(info)).toEqual({ evento: "e", chaveSufixo: "1123456780" });
  });

  it("chaveSufixo não textual é descartado", () => {
    expect(camposLogNumeracao({ chaveSufixo: { chave: "x" } })).toEqual({});
  });

  it("strings truncadas em 200 caracteres (evento inclusive)", () => {
    const info = capturar("info");
    logNumeracao("e".repeat(500), { motivo: "m".repeat(1000), codigoProvedor: "c".repeat(300) });
    const saida = linhaJson(info);
    expect((saida.evento as string).length).toBe(200);
    expect((saida.motivo as string).length).toBe(200);
    expect((saida.codigoProvedor as string).length).toBe(200);
  });

  it("primitivos: número, boolean, null, Date e bigint", () => {
    expect(
      camposLogNumeracao({
        numero: 101,
        latenciaMs: NaN,
        lockEsperaMs: 12.5,
        estado: null,
        de: new Date("2026-09-17T12:00:00.000Z"),
        para: new Date("x"),
        tentativa: BigInt(3),
        origem: true,
        classe: undefined,
      }),
    ).toEqual({
      numero: 101,
      latenciaMs: "NaN",
      lockEsperaMs: 12.5,
      estado: null,
      de: "2026-09-17T12:00:00.000Z",
      para: null,
      tentativa: "3",
      origem: true,
    });
  });

  it("campos nulos/ausentes não quebram", () => {
    const info = capturar("info");
    logNumeracao("so-evento");
    expect(linhaJson(info)).toEqual({ evento: "so-evento" });
    expect(camposLogNumeracao(null)).toEqual({});
    expect(camposLogNumeracao(undefined)).toEqual({});
  });

  it("campos não podem sobrescrever o evento", () => {
    const info = capturar("info");
    logNumeracao("real", { evento: "falso" } as Record<string, unknown>);
    expect(linhaJson(info)).toEqual({ evento: "real" });
  });

  it("falha do console nunca propaga (log é best-effort)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stdout fechado");
    });
    expect(() => logNumeracao("e", { numero: 1 }, "error")).not.toThrow();
  });
});
