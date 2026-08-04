import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  resolveCstCsosn,
  toWinAnsiSafe,
  toWinAnsiSafeLine,
  wrapTextLines,
} from "../../app/fiscal/generators/danfe-helpers";

describe("resolveCstCsosn", () => {
  it("Simples Nacional usa CSOSN com default 102", () => {
    expect(resolveCstCsosn("SIMPLES")).toEqual({
      label: "CSOSN",
      value: "102",
    });
  });

  it("Simples respeita um CSOSN específico", () => {
    expect(resolveCstCsosn("SIMPLES", "500")).toEqual({
      label: "CSOSN",
      value: "500",
    });
  });

  it("regime normal usa CST com default 00", () => {
    expect(resolveCstCsosn("LUCRO_PRESUMIDO")).toEqual({
      label: "CST",
      value: "00",
    });
    expect(resolveCstCsosn("LUCRO_REAL")).toEqual({
      label: "CST",
      value: "00",
    });
  });

  it("regime normal respeita um CST específico", () => {
    expect(resolveCstCsosn("LUCRO_REAL", "20")).toEqual({
      label: "CST",
      value: "20",
    });
  });

  it("cstIcms vazio/branco cai no default do regime", () => {
    expect(resolveCstCsosn("SIMPLES", "").value).toBe("102");
    expect(resolveCstCsosn("SIMPLES", "   ").value).toBe("102");
    expect(resolveCstCsosn("LUCRO_PRESUMIDO", null).value).toBe("00");
  });

  it("regime nulo/desconhecido é tratado como normal (CST)", () => {
    expect(resolveCstCsosn(null)).toEqual({ label: "CST", value: "00" });
    expect(resolveCstCsosn(undefined)).toEqual({ label: "CST", value: "00" });
  });
});

// ──────────────────────────────────────────────────────────────────
// toWinAnsiSafe — o oráculo é o PRÓPRIO pdf-lib, não uma lista escrita à mão.
// `widthOfTextAtSize` lança igual a `drawText`, então medir texto cru (para
// quebrar linha ou truncar) derruba a geração ANTES de desenhar qualquer coisa.
// ──────────────────────────────────────────────────────────────────

describe("toWinAnsiSafe — segurança contra o encoder do pdf-lib", () => {
  async function fonts() {
    const doc = await PDFDocument.create();
    return {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
  }

  it("nenhum codepoint 0x00..0xFFFF sobrevive ao saneamento de forma não-desenhável", async () => {
    const { regular } = await fonts();
    const problematicos: string[] = [];
    for (let c = 0x00; c <= 0xffff; c++) {
      // Substitutos UTF-16 isolados não formam caractere — pulamos.
      if (c >= 0xd800 && c <= 0xdfff) continue;
      // `\n` é preservado de propósito (contrato com wrapTextLines) e por isso
      // é medido pelas linhas quebradas, nunca inteiro.
      const saneado = toWinAnsiSafeLine(String.fromCodePoint(c));
      if (saneado === "") continue;
      try {
        regular.widthOfTextAtSize(saneado, 8);
      } catch {
        problematicos.push(`0x${c.toString(16)}`);
      }
    }
    expect(problematicos).toEqual([]);
  });

  it("emoji (fora do BMP) vira '?' e é mensurável", async () => {
    const { regular, bold } = await fonts();
    const s = toWinAnsiSafeLine("Entrega expressa \u{1F69A} ate sexta \u{1F600}");
    expect(s).toBe("Entrega expressa ? ate sexta ?");
    expect(() => regular.widthOfTextAtSize(s, 8)).not.toThrow();
    expect(() => bold.widthOfTextAtSize(s, 8)).not.toThrow();
  });

  it("REGRESSÃO: a faixa C1 (0x80–0x9F) era o buraco do `code <= 0xff`", async () => {
    const { regular } = await fonts();
    const cru = "A\u0081B\u008dC\u008fD\u0090E\u009dF";
    // Antes do endurecimento estes bytes passavam direto e faziam o pdf-lib lançar.
    expect(() => regular.widthOfTextAtSize(cru, 8)).toThrow();
    const saneado = toWinAnsiSafeLine(cru);
    expect(saneado).toBe("ABCDEF");
    expect(() => regular.widthOfTextAtSize(saneado, 8)).not.toThrow();
  });

  it("REGRESSÃO: controles C0 e DEL também derrubavam a medição", async () => {
    const { regular } = await fonts();
    expect(() => regular.widthOfTextAtSize("a\u0000b", 8)).toThrow();
    expect(() => regular.widthOfTextAtSize("a\u007fb", 8)).toThrow();
    expect(toWinAnsiSafeLine("a\u0000b\u007fc\u001fd")).toBe("abcd");
  });

  it("acentos latinos e tipografia do CP-1252 são PRESERVADOS", () => {
    const s = "AUTOPEÇAS SÃO JOÃO — ELETRÔNICA… • 1º ª €";
    expect(toWinAnsiSafeLine(s)).toBe(s);
  });

  it("tab vira espaço; espaços repetidos colapsam em toWinAnsiSafeLine", () => {
    expect(toWinAnsiSafeLine("a\tb")).toBe("a b");
    expect(toWinAnsiSafeLine("  a   b  ")).toBe("a b");
  });

  it("toWinAnsiSafe PRESERVA \\n (contrato com wrapTextLines)", () => {
    expect(toWinAnsiSafe("linha 1\nlinha 2")).toBe("linha 1\nlinha 2");
    // ...e toWinAnsiSafeLine não, porque vai direto para drawText.
    expect(toWinAnsiSafeLine("linha 1\nlinha 2")).toBe("linha 1 linha 2");
  });

  it("infCpl multilinha continua quebrando por parágrafo e é mensurável", async () => {
    const { regular } = await fonts();
    const infCpl = toWinAnsiSafe("Observação 1 \u{1F600}\nObservação 2\tcom tab");
    const linhas = wrapTextLines(infCpl, 200, (t) => regular.widthOfTextAtSize(t, 8));
    expect(linhas.length).toBeGreaterThanOrEqual(2);
    for (const l of linhas) {
      expect(() => regular.widthOfTextAtSize(l, 8)).not.toThrow();
    }
  });

  it("entrada null/undefined não quebra", () => {
    expect(toWinAnsiSafe(null as unknown as string)).toBe("");
    expect(toWinAnsiSafeLine(undefined as unknown as string)).toBe("");
  });
});
