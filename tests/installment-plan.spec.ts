import { describe, it, expect } from "vitest";

import { buildInstallmentPlan } from "../app/financeiro/lib/installment-plan";

// ──────────────────────────────────────────────────────────
// Bloco B — o calculador do plano de entrada + parcelas.
//
// É a MESMA função que desenha a prévia na tela e que monta o payload enviado
// ao backend. Se ela errar um centavo, a tela mostra um valor e o banco grava
// outro — e o backend rejeita a venda com "entrada + parcelas não fecham".
//
// Invariante que TODO caso precisa respeitar:
//     entrada + Σ parcelas === total, ao centavo.
// ──────────────────────────────────────────────────────────

const cents = (v: number) => Math.round(v * 100);

function somaFecha(total: number, plano: NonNullable<ReturnType<typeof buildInstallmentPlan>>) {
  const soma =
    cents(plano.downPayment) +
    plano.installments.reduce((acc, p) => acc + cents(p.amount), 0);
  return soma === cents(total);
}

describe("buildInstallmentPlan — fechamento ao centavo", () => {
  it("divisão exata: 1000 = 300 + 7x100", () => {
    const plano = buildInstallmentPlan({
      totalAmount: 1000,
      downPayment: 300,
      count: 7,
      periodDays: 30,
      firstDueDate: "2026-09-10",
    })!;
    expect(plano.balance).toBe(700);
    expect(plano.installments).toHaveLength(7);
    expect(plano.installments.every((p) => p.amount === 100)).toBe(true);
    expect(somaFecha(1000, plano)).toBe(true);
  });

  // O caso que quebra qualquer implementação em float: 100/3.
  it("divisão inexata: a ÚLTIMA parcela absorve o resíduo", () => {
    const plano = buildInstallmentPlan({
      totalAmount: 100,
      downPayment: 10,
      count: 3,
      periodDays: 30,
      firstDueDate: "2026-09-10",
    })!;
    // saldo 90 / 3 = 30 exatos
    expect(plano.installments.map((p) => p.amount)).toEqual([30, 30, 30]);

    const outro = buildInstallmentPlan({
      totalAmount: 100,
      downPayment: 0.01,
      count: 3,
      periodDays: 30,
      firstDueDate: "2026-09-10",
    })!;
    // saldo 99,99 / 3 = 33,33 exatos
    expect(outro.installments.map((p) => p.amount)).toEqual([33.33, 33.33, 33.33]);
    expect(somaFecha(100, outro)).toBe(true);
  });

  it("resíduo real: 1000 − 1 = 999 em 7x", () => {
    const plano = buildInstallmentPlan({
      totalAmount: 1000,
      downPayment: 1,
      count: 7,
      periodDays: 30,
      firstDueDate: "2026-09-10",
    })!;
    // 99900 / 7 = 14271,43 => 14271 nas 6 primeiras, última leva o resto
    const valores = plano.installments.map((p) => cents(p.amount));
    expect(valores.slice(0, 6).every((v) => v === 14271)).toBe(true);
    expect(valores[6]).toBe(99900 - 14271 * 6);
    expect(somaFecha(1000, plano)).toBe(true);
  });

  it("nunca gera parcela de zero nem negativa", () => {
    for (const count of [1, 2, 3, 5, 7, 12, 24]) {
      for (const total of [10, 99.99, 100, 333.33, 1000, 4999.95]) {
        for (const entrada of [0.01, 1, total / 3]) {
          const plano = buildInstallmentPlan({
            totalAmount: total,
            downPayment: Number(entrada.toFixed(2)),
            count,
            periodDays: 30,
            firstDueDate: "2026-09-10",
          });
          if (!plano) continue;
          expect(plano.installments.every((p) => p.amount > 0)).toBe(true);
          expect(somaFecha(total, plano)).toBe(true);
        }
      }
    }
  });
});

describe("buildInstallmentPlan — vencimentos", () => {
  // As datas são geradas em UTC de propósito: "2026-09-10" é meia-noite UTC,
  // e somar dias no fuso local faria o vencimento andar um dia para quem está
  // em UTC-3 (o dia 10 viraria dia 9).
  it("primeira parcela vence na data informada", () => {
    const plano = buildInstallmentPlan({
      totalAmount: 1000,
      downPayment: 300,
      count: 3,
      periodDays: 30,
      firstDueDate: "2026-09-10",
    })!;
    expect(plano.installments[0].dueDate.slice(0, 10)).toBe("2026-09-10");
  });

  it("as seguintes andam de periodDays em periodDays", () => {
    const plano = buildInstallmentPlan({
      totalAmount: 1000,
      downPayment: 300,
      count: 3,
      periodDays: 30,
      firstDueDate: "2026-09-10",
    })!;
    expect(plano.installments.map((p) => p.dueDate.slice(0, 10))).toEqual([
      "2026-09-10",
      "2026-10-10",
      "2026-11-09",
    ]);
  });

  it("atravessa a virada de ano sem escorregar", () => {
    const plano = buildInstallmentPlan({
      totalAmount: 400,
      downPayment: 100,
      count: 3,
      periodDays: 30,
      firstDueDate: "2026-12-20",
    })!;
    expect(plano.installments.map((p) => p.dueDate.slice(0, 10))).toEqual([
      "2026-12-20",
      "2027-01-19",
      "2027-02-18",
    ]);
  });

  it("periodDays 0 empilha tudo no mesmo dia (não quebra)", () => {
    const plano = buildInstallmentPlan({
      totalAmount: 300,
      downPayment: 100,
      count: 2,
      periodDays: 0,
      firstDueDate: "2026-09-10",
    })!;
    expect(plano.installments.map((p) => p.dueDate.slice(0, 10))).toEqual([
      "2026-09-10",
      "2026-09-10",
    ]);
  });
});

describe("buildInstallmentPlan — recusa planos inválidos (null, sem lançar)", () => {
  const base = {
    totalAmount: 1000,
    downPayment: 300,
    count: 3,
    periodDays: 30,
    firstDueDate: "2026-09-10",
  };

  it.each([
    ["total zero", { totalAmount: 0 }],
    ["entrada zero (é fiado, tem caminho próprio)", { downPayment: 0 }],
    ["entrada igual ao total (é à vista)", { downPayment: 1000 }],
    ["entrada maior que o total", { downPayment: 1200 }],
    ["zero parcelas", { count: 0 }],
    ["mais parcelas do que centavos do saldo", { downPayment: 999.99, count: 5 }],
    ["data inválida", { firstDueDate: "não é data" }],
    ["data vazia", { firstDueDate: "" }],
  ])("%s => null", (_label, over) => {
    expect(buildInstallmentPlan({ ...base, ...over })).toBeNull();
  });

  it("1 parcela é válido (entrada + 1 parcela)", () => {
    const plano = buildInstallmentPlan({ ...base, count: 1 })!;
    expect(plano.installments).toHaveLength(1);
    expect(plano.installments[0].amount).toBe(700);
  });
});
