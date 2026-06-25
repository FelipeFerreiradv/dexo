import { describe, it, expect } from "vitest";
import {
  aggregateFinanceReport,
  effectiveStatus,
  type FinanceEntryInput,
} from "./finance-report";

const range = {
  startDate: new Date("2026-06-01T00:00:00Z"),
  endDate: new Date("2026-06-03T23:59:59Z"),
};
const now = new Date("2026-06-25T12:00:00Z");

function r(
  totalAmount: number,
  status: FinanceEntryInput["status"],
  opts: Partial<FinanceEntryInput> = {},
): FinanceEntryInput {
  return {
    totalAmount,
    status,
    dueDate: opts.dueDate ?? new Date("2026-07-01T00:00:00Z"),
    paymentMethod: opts.paymentMethod ?? null,
    createdAt: opts.createdAt ?? new Date("2026-06-01T10:00:00Z"),
    hasItems: opts.hasItems,
  };
}

describe("effectiveStatus", () => {
  it("PENDENTE vencida vira VENCIDA; no prazo continua PENDENTE", () => {
    expect(
      effectiveStatus("PENDENTE", new Date("2026-06-10T00:00:00Z"), now),
    ).toBe("VENCIDA");
    expect(
      effectiveStatus("PENDENTE", new Date("2026-07-10T00:00:00Z"), now),
    ).toBe("PENDENTE");
    expect(effectiveStatus("PAGA", new Date("2026-01-01"), now)).toBe("PAGA");
  });
});

describe("aggregateFinanceReport", () => {
  it("diferencia venda balcão (com itens) de a receber avulsa", () => {
    const receivables = [
      r(100, "PAGA", { hasItems: true, paymentMethod: "PIX" }), // balcão recebido
      r(50, "PENDENTE", { hasItems: true }), // balcão pendente
      r(200, "PAGA", { hasItems: false, paymentMethod: "BOLETO" }), // avulsa recebida
    ];
    const payables = [r(80, "PAGA", { paymentMethod: "PIX" })];

    const res = aggregateFinanceReport(receivables, payables, range, now);

    expect(res.receber.total).toBe(350);
    expect(res.receber.pago).toBe(300);
    expect(res.balcao.total).toBe(150);
    expect(res.balcao.pago).toBe(100);
    expect(res.balcao.count).toBe(2);
    expect(res.receberAvulso.total).toBe(200);
    expect(res.pagar.total).toBe(80);
    expect(res.pagar.pago).toBe(80);
    // saldos
    expect(res.saldoPrevisto).toBe(350 - 80);
    expect(res.saldoRealizado).toBe(300 - 80);
    // balcao + avulso = receber
    expect(res.balcao.total + res.receberAvulso.total).toBe(res.receber.total);
  });

  it("exclui CANCELADA dos totais", () => {
    const res = aggregateFinanceReport(
      [r(100, "PAGA"), r(999, "CANCELADA")],
      [r(50, "CANCELADA")],
      range,
      now,
    );
    expect(res.receber.total).toBe(100);
    expect(res.pagar.total).toBe(0);
  });

  it("recalcula VENCIDA por dueDate < now", () => {
    const res = aggregateFinanceReport(
      [
        r(100, "PENDENTE", { dueDate: new Date("2026-06-10T00:00:00Z") }), // vencida
        r(40, "PENDENTE", { dueDate: new Date("2026-12-01T00:00:00Z") }), // no prazo
      ],
      [],
      range,
      now,
    );
    expect(res.receber.vencido).toBe(100);
    expect(res.receber.pendente).toBe(40);
  });

  it("agrupa por forma de pagamento (receber e pagar) ordenado desc", () => {
    const res = aggregateFinanceReport(
      [
        r(100, "PAGA", { paymentMethod: "PIX" }),
        r(30, "PAGA", { paymentMethod: null }),
      ],
      [r(200, "PAGA", { paymentMethod: "PIX" })],
      range,
      now,
    );
    expect(res.byMethod[0].method).toBe("PIX");
    expect(res.byMethod[0].receber).toBe(100);
    expect(res.byMethod[0].pagar).toBe(200);
    const semMetodo = res.byMethod.find((m) => m.method === null)!;
    expect(semMetodo.receber).toBe(30);
  });

  it("timeseries cobre o intervalo por createdAt (zeros incluídos)", () => {
    const res = aggregateFinanceReport(
      [r(100, "PAGA", { createdAt: new Date("2026-06-01T10:00:00Z") })],
      [r(50, "PAGA", { createdAt: new Date("2026-06-03T10:00:00Z") })],
      range,
      now,
    );
    expect(res.timeseries.map((t) => t.date)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
    expect(res.timeseries[0]).toMatchObject({ receber: 100, pagar: 0 });
    expect(res.timeseries[2]).toMatchObject({ receber: 0, pagar: 50 });
  });
});
