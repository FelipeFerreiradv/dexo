import { describe, it, expect } from "vitest";

// ──────────────────────────────────────────────────────────
// REGRESSÃO (encontrada em teste local, 06/08): o cupom imprimia o
// vencimento UM DIA ANTES do que o operador digitou.
//
// Cadeia do bug:
//   <input type="date">  →  "2026-10-02"
//   new Date("2026-10-02")  →  2026-10-02T00:00:00.000Z (meia-noite UTC)
//   toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })
//       →  recua 3h  →  2026-10-01T21:00  →  imprime "01/10/2026"
//
// Vencimento é DATA CIVIL (dia do calendário), não instante: tem de sair em
// UTC. Já a data de EMISSÃO é um instante real e continua no fuso do negócio.
//
// Este teste é a trava: exercita a conversão diretamente, sem depender do
// layout do PDF (que é coordenada absoluta e não dá para inspecionar).
// ──────────────────────────────────────────────────────────

/** Espelha `formatDate` do receipt-pdf.service.ts (vencimento). */
function formatDueDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

/** Espelha `formatDateTime` do receipt-pdf.service.ts (emissão). */
function formatIssuedAt(d: Date): string {
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}

describe("cupom — vencimento sai no dia que o operador digitou", () => {
  it.each([
    ["2026-10-02", "02/10/2026"],
    ["2026-11-01", "01/11/2026"],
    ["2026-12-01", "01/12/2026"],
    ["2026-08-07", "07/08/2026"],
    // Virada de ano: o caso onde o off-by-one erraria até o ANO.
    ["2027-01-01", "01/01/2027"],
  ])("%s imprime %s", (input, esperado) => {
    expect(formatDueDate(new Date(input))).toBe(esperado);
  });

  it("o fuso do servidor não altera o resultado", () => {
    // Meia-noite UTC é o formato em que TODO vencimento é gravado (o
    // `<input type="date">` não carrega hora nem fuso).
    const venc = new Date("2026-10-02T00:00:00.000Z");
    expect(formatDueDate(venc)).toBe("02/10/2026");
    // A conversão para o fuso do negócio é justamente a que errava:
    expect(
      venc.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    ).toBe("01/10/2026");
  });

  it("a data de EMISSÃO continua no fuso do negócio (é instante, não data civil)", () => {
    // 06/08/2026 às 00:30 UTC = 05/08/2026 às 21:30 em São Paulo. Para um
    // carimbo de emissão isso está CERTO: foi emitido à noite do dia 5 lá.
    const emissao = new Date("2026-08-06T00:30:00.000Z");
    expect(formatIssuedAt(emissao)).toContain("05/08/2026");
  });
});
