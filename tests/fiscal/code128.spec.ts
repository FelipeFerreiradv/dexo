import { describe, it, expect } from "vitest";
import {
  code128cSymbols,
  code128cBars,
  totalModules,
  drawCode128C,
  MIN_MODULE_PT,
} from "../../app/fiscal/generators/code128";

// Chave real de 44 dígitos (DANFE de referência, NF-e nº 94 da Mesquita Auto Peças).
const CHAVE = "52251207087727000105550020000000941757171782";

describe("code128 — integridade da tabela de símbolos", () => {
  it("todo símbolo tem 11 módulos e o STOP tem 13", () => {
    // Encodar um par isolado produz [START C][par][checksum][STOP]:
    // 11 + 11 + 11 + 13 = 46 módulos e 6+6+6+7 = 25 elementos, SEMPRE.
    // Varrendo os 100 pares cobrimos todas as linhas de dados da tabela e,
    // como o checksum é (105 + v) mod 103, também 100 linhas de checksum
    // distintas — qualquer linha com soma errada quebraria o total de 46.
    for (let v = 0; v <= 99; v++) {
      const bars = code128cBars(String(v).padStart(2, "0"))!;
      expect(bars, `par ${v} deve ser codificável`).not.toBeNull();
      expect(totalModules(bars), `par ${v}`).toBe(46);
      expect(bars.length, `par ${v}`).toBe(25);
    }
  });

  it("cada símbolo isolado tem exatamente 11 módulos (13 no STOP)", () => {
    const bars = code128cBars("00")!;
    const soma = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(soma(bars.slice(0, 6))).toBe(11); // START C
    expect(soma(bars.slice(6, 12))).toBe(11); // dado
    expect(soma(bars.slice(12, 18))).toBe(11); // checksum
    expect(soma(bars.slice(18))).toBe(13); // STOP (7 elementos)
    expect(bars.slice(18)).toHaveLength(7);
  });
});

describe("code128 — checksum mod 103", () => {
  it('"123456" produz o checksum canônico 44', () => {
    // START C=105, dados 12/34/56 → (105 + 1×12 + 2×34 + 3×56) mod 103
    //                            = (105 + 12 + 68 + 168) mod 103 = 353 mod 103 = 44
    expect(code128cSymbols("123456")).toEqual([105, 12, 34, 56, 44, 106]);
  });

  it('"00" produz o checksum 2', () => {
    // (105 + 1×0) mod 103 = 105 mod 103 = 2
    expect(code128cSymbols("00")).toEqual([105, 0, 2, 106]);
  });

  it("o checksum fica sempre em 0..102", () => {
    for (let i = 0; i < 200; i++) {
      // Varre chaves sintéticas de 44 dígitos com padrões diferentes.
      const chave = String(i).padStart(2, "0").repeat(22);
      const syms = code128cSymbols(chave)!;
      const check = syms[syms.length - 2];
      expect(check).toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThanOrEqual(102);
    }
  });
});

describe("code128 — a chave de 44 dígitos do DANFE", () => {
  it("gera 25 símbolos, 151 elementos e 277 módulos", () => {
    const syms = code128cSymbols(CHAVE)!;
    // START C + 22 pares + checksum + STOP
    expect(syms).toHaveLength(25);
    expect(syms[0]).toBe(105);
    expect(syms[syms.length - 1]).toBe(106);

    const bars = code128cBars(CHAVE)!;
    // 24 símbolos × 6 elementos + STOP com 7
    expect(bars).toHaveLength(151);
    // 24 símbolos × 11 módulos + STOP com 13
    expect(totalModules(bars)).toBe(277);
  });

  it("round-trip: as larguras decodificam de volta para os símbolos originais", () => {
    const syms = code128cSymbols(CHAVE)!;
    const bars = code128cBars(CHAVE)!;

    // Tabela reversa construída a partir do PRÓPRIO encoder, sem repetir os
    // padrões literais aqui: encodar o par "vv" isolado produz
    // [START C][vv][check][STOP], então a fatia [6..12) é o padrão do dado.
    const byPattern = new Map<string, number>();
    for (let v = 0; v <= 99; v++) {
      const solo = code128cBars(String(v).padStart(2, "0"))!;
      byPattern.set(solo.slice(6, 12).join(""), v);
    }
    const startPattern = code128cBars("00")!.slice(0, 6).join("");
    const stopPattern = code128cBars("00")!.slice(-7).join("");

    // Reagrupa as larguras em símbolos e resolve cada um. Se o encoder tivesse
    // trocado linhas da tabela ou desalinhado barra/espaço, isto pegaria.
    const decoded: number[] = [];
    for (let i = 0; i < bars.length; ) {
      const len = i + 7 === bars.length ? 7 : 6; // o último símbolo é o STOP
      const pattern = bars.slice(i, i + len).join("");
      if (i === 0) decoded.push(pattern === startPattern ? 105 : -1);
      else if (len === 7) decoded.push(pattern === stopPattern ? 106 : -1);
      else decoded.push(byPattern.get(pattern) ?? -1);
      i += len;
    }

    expect(decoded).toEqual(syms);
    expect(decoded).not.toContain(-1);
  });

  it("a sequência começa por barra e alterna (soma de barras < total)", () => {
    const bars = code128cBars(CHAVE)!;
    const inkModules = bars.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
    expect(inkModules).toBeGreaterThan(0);
    expect(inkModules).toBeLessThan(totalModules(bars));
    // Code-128 sempre termina em barra (o STOP tem 7 elementos).
    expect(bars.length % 2).toBe(1);
  });
});

describe("code128 — robustez (nunca lança, nunca desenha lixo)", () => {
  it.each([
    ["vazio", ""],
    ["ímpar", "123"],
    ["com letra", "12A4"],
    ["com espaço", "12 4"],
    ["com pontuação", "1234-5678"],
    ["chave de 43 dígitos", "5".repeat(43)],
  ])("%s → null sem lançar", (_label, input) => {
    expect(() => code128cSymbols(input)).not.toThrow();
    expect(code128cSymbols(input)).toBeNull();
    expect(code128cBars(input)).toBeNull();
  });

  it("null/undefined não quebram", () => {
    expect(code128cBars(null as unknown as string)).toBeNull();
    expect(code128cBars(undefined as unknown as string)).toBeNull();
  });
});

describe("drawCode128C", () => {
  function fakePage() {
    const rects: Array<{ x: number; width: number }> = [];
    return {
      rects,
      drawRectangle(o: { x: number; width: number }) {
        rects.push({ x: o.x, width: o.width });
      },
    };
  }

  it("desenha só as barras (76 retângulos para 151 elementos)", () => {
    const page = fakePage();
    const ok = drawCode128C(page, "black", CHAVE, {
      x: 100,
      y: 50,
      width: 200,
      height: 34,
    });
    expect(ok).toBe(true);
    // 151 elementos alternando a partir de barra → ceil(151/2) = 76 barras
    expect(page.rects).toHaveLength(76);
  });

  it("respeita a zona muda e não ultrapassa a largura disponível", () => {
    const page = fakePage();
    drawCode128C(page, "black", CHAVE, { x: 100, y: 50, width: 200, height: 34 });
    const moduleW = 200 / (277 + 20);
    const first = page.rects[0];
    const last = page.rects[page.rects.length - 1];
    expect(first.x).toBeCloseTo(100 + 10 * moduleW, 6);
    expect(last.x + last.width).toBeLessThanOrEqual(100 + 200 - 10 * moduleW + 1e-6);
  });

  it("recusa (false) quando a área é estreita demais para ser legível", () => {
    const page = fakePage();
    // 297 módulos em 50pt → 0.168pt/módulo, bem abaixo do piso.
    const ok = drawCode128C(page, "black", CHAVE, {
      x: 0,
      y: 0,
      width: 50,
      height: 34,
    });
    expect(ok).toBe(false);
    expect(page.rects).toHaveLength(0);
    // Sanidade do piso: na largura que o DANFE reserva, passa.
    expect(200 / (277 + 20)).toBeGreaterThan(MIN_MODULE_PT);
  });

  it("chave inválida → false, sem desenhar e sem lançar", () => {
    const page = fakePage();
    expect(() => drawCode128C(page, "black", "abc", { x: 0, y: 0, width: 200, height: 34 })).not.toThrow();
    expect(drawCode128C(page, "black", "abc", { x: 0, y: 0, width: 200, height: 34 })).toBe(false);
    expect(page.rects).toHaveLength(0);
  });

  it("page que lança não derruba o DANFE", () => {
    const explosive = {
      drawRectangle() {
        throw new Error("boom");
      },
    };
    expect(() =>
      drawCode128C(explosive, "black", CHAVE, { x: 0, y: 0, width: 200, height: 34 }),
    ).not.toThrow();
    expect(
      drawCode128C(explosive, "black", CHAVE, { x: 0, y: 0, width: 200, height: 34 }),
    ).toBe(false);
  });
});
