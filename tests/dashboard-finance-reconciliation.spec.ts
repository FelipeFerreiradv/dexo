import { describe, expect, it } from "vitest";

import {
  aggregateFinanceReport,
  type FinanceEntryInput,
} from "../app/lib/finance-report";
import {
  buildChannelSplit,
  buildPaymentMethodBreakdown,
  type FinanceBucketRow,
} from "../app/lib/dashboard-breakdowns";

/**
 * CADEADO ANTI-DRIFT entre o Dashboard e o Financeiro.
 *
 * O relatório em PDF (/finance/report.pdf) agrega em JS via
 * `aggregateFinanceReport`. Os gráficos do Dashboard agregam NO BANCO (convenção
 * EGRESS: um GROUP BY em vez de uma linha por Receivable a cada page view), com
 * FILTERs que replicam `effectiveStatus` de finance-report.ts:52-61.
 *
 * Dois caminhos para o mesmo número ⇒ risco de divergirem em silêncio. Este
 * spec alimenta as MESMAS entradas nos dois e exige resultados idênticos.
 *
 * `simulateSqlBuckets` é escrita conforme o SQL (predicados literais), NÃO
 * chamando `effectiveStatus`. É isso que faz o teste morder: se alguém mudar a
 * regra no TS sem mudar o SQL (ou vice-versa), os lados divergem aqui.
 */

const NOW = new Date("2026-07-29T12:00:00.000Z");
const RANGE = {
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-31T23:59:59.999Z"),
};

function entry(
  totalAmount: number,
  status: FinanceEntryInput["status"],
  opts: {
    dueDate?: string;
    paymentMethod?: string | null;
    hasItems?: boolean;
    createdAt?: string;
  } = {},
): FinanceEntryInput {
  return {
    totalAmount,
    status,
    dueDate: new Date(opts.dueDate ?? "2026-08-15T00:00:00.000Z"),
    paymentMethod: opts.paymentMethod ?? null,
    createdAt: new Date(opts.createdAt ?? "2026-07-10T00:00:00.000Z"),
    hasItems: opts.hasItems,
  };
}

/**
 * Reproduz o que o Postgres devolve, com os MESMOS predicados do
 * dashboard-breakdowns.query.ts:
 *   - WHERE status <> 'CANCELADA'
 *   - pago     = SUM(...) FILTER (status = 'PAGA')
 *   - pendente = SUM(...) FILTER (status = 'PENDENTE' AND dueDate >= now)
 *   - vencido  = SUM(...) FILTER (status = 'VENCIDA'
 *                                 OR (status = 'PENDENTE' AND dueDate < now))
 * `total` e `count` somam tudo que sobrou do WHERE.
 */
function simulateSqlBuckets(
  entries: FinanceEntryInput[],
  keyOf: (e: FinanceEntryInput) => string | null,
  now: Date,
): FinanceBucketRow[] {
  const acc = new Map<
    string,
    { key: string | null; total: number; pago: number; pendente: number; vencido: number; count: number }
  >();

  for (const e of entries) {
    if (e.status === "CANCELADA") continue;
    const key = keyOf(e);
    const mapKey = key === null ? "__null__" : key;
    const b =
      acc.get(mapKey) ??
      { key, total: 0, pago: 0, pendente: 0, vencido: 0, count: 0 };

    b.total += e.totalAmount;
    b.count += 1;
    if (e.status === "PAGA") {
      b.pago += e.totalAmount;
    } else if (e.status === "PENDENTE" && e.dueDate.getTime() >= now.getTime()) {
      b.pendente += e.totalAmount;
    } else if (
      e.status === "VENCIDA" ||
      (e.status === "PENDENTE" && e.dueDate.getTime() < now.getTime())
    ) {
      b.vencido += e.totalAmount;
    }
    acc.set(mapKey, b);
  }

  return Array.from(acc.values()).map((b) => ({
    key: b.key,
    count: b.count,
    total: String(b.total),
    pago: String(b.pago),
    pendente: String(b.pendente),
    vencido: String(b.vencido),
  }));
}

const channelKey = (e: FinanceEntryInput) => (e.hasItems ? "BALCAO" : "AVULSO");
const methodKey = (e: FinanceEntryInput) => e.paymentMethod;

/** Fixture com todas as bordas que separam as duas implementações. */
const FIXTURES: FinanceEntryInput[] = [
  // Balcão, PIX, quitada.
  entry(1000, "PAGA", { paymentMethod: "PIX", hasItems: true }),
  // Balcão, crédito, pendente NO PRAZO.
  entry(500, "PENDENTE", {
    paymentMethod: "CREDITO",
    hasItems: true,
    dueDate: "2026-08-30T00:00:00.000Z",
  }),
  // Avulso, boleto, PENDENTE JÁ VENCIDA (dueDate < now) → deve virar vencido.
  entry(300, "PENDENTE", {
    paymentMethod: "BOLETO",
    dueDate: "2026-07-01T00:00:00.000Z",
  }),
  // Avulso, VENCIDA explícita.
  entry(200, "VENCIDA", { paymentMethod: "BOLETO" }),
  // Avulso SEM forma de pagamento (bucket null é legítimo).
  entry(120, "PAGA", { paymentMethod: null }),
  // CANCELADA: fora dos dois lados.
  entry(9999, "CANCELADA", { paymentMethod: "PIX", hasItems: true }),
  // Borda exata: dueDate === now. `effectiveStatus` usa `<` estrito → PENDENTE.
  entry(80, "PENDENTE", {
    paymentMethod: "DINHEIRO",
    dueDate: NOW.toISOString(),
  }),
];

describe("reconciliação Dashboard ↔ finance-report (forma de venda)", () => {
  const relatorio = aggregateFinanceReport(FIXTURES, [], RANGE, NOW);
  const dashboard = buildChannelSplit(
    simulateSqlBuckets(FIXTURES, channelKey, NOW),
  );

  const balcao = dashboard.items.find((i) => i.channel === "BALCAO")!;
  const avulso = dashboard.items.find((i) => i.channel === "AVULSO")!;

  it("o total de balcão bate com o do relatório", () => {
    expect(balcao.total).toBeCloseTo(relatorio.balcao.total, 6);
    expect(balcao.count).toBe(relatorio.balcao.count);
  });

  it("o total avulso bate com o do relatório", () => {
    expect(avulso.total).toBeCloseTo(relatorio.receberAvulso.total, 6);
    expect(avulso.count).toBe(relatorio.receberAvulso.count);
  });

  it("balcão + avulso = total a receber, nos dois lados", () => {
    expect(balcao.total + avulso.total).toBeCloseTo(relatorio.receber.total, 6);
    expect(dashboard.totals.total).toBeCloseTo(relatorio.receber.total, 6);
  });

  it("os buckets de situação batem (PAGA / PENDENTE / VENCIDA)", () => {
    expect(dashboard.totals.pago).toBeCloseTo(relatorio.receber.pago, 6);
    expect(dashboard.totals.pendente).toBeCloseTo(
      relatorio.receber.pendente,
      6,
    );
    expect(dashboard.totals.vencido).toBeCloseTo(relatorio.receber.vencido, 6);
  });

  it("PENDENTE vencida conta como vencida nos dois caminhos", () => {
    expect(relatorio.receber.vencido).toBeCloseTo(500, 6); // 300 + 200
    expect(dashboard.totals.vencido).toBeCloseTo(500, 6);
  });

  it("dueDate exatamente igual a `now` continua PENDENTE (< estrito)", () => {
    expect(relatorio.receber.pendente).toBeCloseTo(580, 6); // 500 + 80
    expect(dashboard.totals.pendente).toBeCloseTo(580, 6);
  });

  it("CANCELADA fica de fora dos dois lados", () => {
    expect(relatorio.receber.total).toBeCloseTo(2200, 6);
    expect(dashboard.totals.total).toBeCloseTo(2200, 6);
    expect(dashboard.totals.count).toBe(6);
  });
});

describe("reconciliação Dashboard ↔ finance-report (forma de pagamento)", () => {
  const relatorio = aggregateFinanceReport(FIXTURES, [], RANGE, NOW);
  const dashboard = buildPaymentMethodBreakdown(
    simulateSqlBuckets(FIXTURES, methodKey, NOW),
  );

  it("cada método soma o mesmo valor nos dois caminhos", () => {
    for (const item of dashboard.items) {
      const doRelatorio = relatorio.byMethod.find(
        (m) => m.method === item.method,
      );
      expect(
        doRelatorio,
        `método ${item.method} sumiu do relatório`,
      ).toBeTruthy();
      expect(item.total).toBeCloseTo(doRelatorio!.receber, 6);
    }
  });

  it("os dois lados enxergam exatamente o mesmo conjunto de métodos", () => {
    const noDashboard = dashboard.items.map((i) => i.method).sort();
    const noRelatorio = relatorio.byMethod.map((m) => m.method).sort();
    expect(noDashboard).toEqual(noRelatorio);
  });

  it("o bucket sem forma de pagamento sobrevive nos dois", () => {
    const semMetodo = dashboard.items.find((i) => i.method === null)!;
    const doRelatorio = relatorio.byMethod.find((m) => m.method === null)!;
    expect(semMetodo.total).toBeCloseTo(doRelatorio.receber, 6);
    expect(semMetodo.label).toBe("—");
  });

  it("a ordenação por valor desc é a mesma dos dois lados", () => {
    // `byMethod` do relatório ordena por receber+pagar; sem payables, é só receber.
    expect(dashboard.items.map((i) => i.method)).toEqual(
      relatorio.byMethod.map((m) => m.method),
    );
  });

  it("o total por método fecha com o total a receber", () => {
    const soma = dashboard.items.reduce((s, i) => s + i.total, 0);
    expect(soma).toBeCloseTo(relatorio.receber.total, 6);
  });
});
