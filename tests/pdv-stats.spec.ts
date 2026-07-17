import { describe, it, expect } from "vitest";

import { computePdvDayStats } from "@/app/pdv/lib/pdv-stats";

// Estatísticas do dia do PDV — dia LOCAL do caixa, vendas canceladas fora,
// caixa de hoje = PAGA com paidAt hoje (independente de quando foi criada).

const NOW = new Date(2026, 6, 17, 15, 0, 0); // 17/07/2026 15:00 local

function sale(over: Partial<Parameters<typeof computePdvDayStats>[0][number]>) {
  return {
    status: "PAGA",
    totalAmount: 100,
    paymentMethod: "PIX",
    createdAt: new Date(2026, 6, 17, 9, 0, 0),
    paidAt: new Date(2026, 6, 17, 9, 5, 0),
    ...over,
  };
}

describe("computePdvDayStats (PDV)", () => {
  it("vazio => tudo zero", () => {
    const s = computePdvDayStats([], NOW);
    expect(s.receivedToday).toBe(0);
    expect(s.salesTodayCount).toBe(0);
    expect(s.avgTicketToday).toBe(0);
    expect(s.byMethodToday).toEqual([]);
  });

  it("caixa de hoje soma só PAGA com paidAt hoje", () => {
    const s = computePdvDayStats(
      [
        sale({ totalAmount: 100 }),
        sale({ totalAmount: 50, paymentMethod: "DINHEIRO" }),
        // paga ONTEM — fora do caixa de hoje
        sale({
          totalAmount: 999,
          createdAt: new Date(2026, 6, 16, 9, 0, 0),
          paidAt: new Date(2026, 6, 16, 10, 0, 0),
        }),
        // pendente hoje — não entra no caixa
        sale({ status: "PENDENTE", paidAt: null, totalAmount: 70 }),
      ],
      NOW,
    );
    expect(s.receivedToday).toBe(150);
    expect(s.receivedTodayCount).toBe(2);
  });

  it("venda antiga recebida HOJE entra no caixa de hoje (mas não em vendas de hoje)", () => {
    const s = computePdvDayStats(
      [
        sale({
          totalAmount: 200,
          createdAt: new Date(2026, 6, 10, 9, 0, 0),
          paidAt: new Date(2026, 6, 17, 11, 0, 0),
        }),
      ],
      NOW,
    );
    expect(s.receivedToday).toBe(200);
    expect(s.salesTodayCount).toBe(0);
  });

  it("vendas de hoje: criadas hoje (qualquer status), CANCELADA fora; ticket médio", () => {
    const s = computePdvDayStats(
      [
        sale({ totalAmount: 100 }),
        sale({ status: "PENDENTE", paidAt: null, totalAmount: 50 }),
        sale({ status: "VENCIDA", paidAt: null, totalAmount: 30 }),
        sale({ status: "CANCELADA", paidAt: null, totalAmount: 500 }),
      ],
      NOW,
    );
    expect(s.salesTodayCount).toBe(3);
    expect(s.salesTodayAmount).toBe(180);
    expect(s.avgTicketToday).toBe(60);
  });

  it("breakdown por forma: agrupa, ordena por valor desc e agrupa sem forma como null", () => {
    const s = computePdvDayStats(
      [
        sale({ totalAmount: 40, paymentMethod: "PIX" }),
        sale({ totalAmount: 100, paymentMethod: "DINHEIRO" }),
        sale({ totalAmount: 20, paymentMethod: "PIX" }),
        sale({ totalAmount: 10, paymentMethod: null }),
      ],
      NOW,
    );
    expect(s.byMethodToday).toEqual([
      { code: "DINHEIRO", amount: 100 },
      { code: "PIX", amount: 60 },
      { code: null, amount: 10 },
    ]);
  });

  it("datas em string ISO funcionam (payload real da API)", () => {
    const s = computePdvDayStats(
      [
        sale({
          totalAmount: 80,
          createdAt: new Date(2026, 6, 17, 8, 0, 0).toISOString(),
          paidAt: new Date(2026, 6, 17, 8, 1, 0).toISOString(),
        }),
      ],
      NOW,
    );
    expect(s.receivedToday).toBe(80);
    expect(s.salesTodayCount).toBe(1);
  });
});
