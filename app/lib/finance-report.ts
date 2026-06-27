/**
 * Agregação PURA (sem DB) do relatório financeiro do período. Recebe contas a
 * receber e a pagar JÁ filtradas pela rota (lançadas no período via `createdAt`,
 * excluindo CANCELADA). Diferencia:
 *  - Contas a Receber (todas)  ·  Contas a Pagar (todas)
 *  - Venda Balcão = conta a receber COM itens (ReceivableItem) — gerou cupom
 *    fiscal/venda no balcão. As demais a receber são "avulsas".
 * Situação por conta é recalculada no momento do relatório (PENDENTE vencida →
 * VENCIDA), igual ao FinanceUseCase. Lógica isolada aqui p/ ser testável.
 */

export type FinanceStatusRaw = "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";
export type EffectiveStatus = "PAGA" | "PENDENTE" | "VENCIDA";

export interface FinanceEntryInput {
  totalAmount: number;
  status: FinanceStatusRaw;
  dueDate: Date;
  paymentMethod: string | null;
  createdAt: Date;
  /** Receivable com ReceivableItem ⇒ venda balcão. Sempre false p/ payables. */
  hasItems?: boolean;
}

export interface StatusBucket {
  total: number;
  pago: number; // PAGA (recebido / pago)
  pendente: number; // PENDENTE no prazo
  vencido: number; // VENCIDA
  count: number;
}

export interface FinanceReportResult {
  receber: StatusBucket;
  pagar: StatusBucket;
  balcao: StatusBucket;
  receberAvulso: StatusBucket;
  saldoPrevisto: number; // receber.total − pagar.total
  saldoRealizado: number; // receber.pago − pagar.pago
  byMethod: Array<{ method: string | null; receber: number; pagar: number }>;
  timeseries: Array<{ date: string; receber: number; pagar: number }>;
}

function emptyBucket(): StatusBucket {
  return { total: 0, pago: 0, pendente: 0, vencido: 0, count: 0 };
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function effectiveStatus(
  status: FinanceStatusRaw,
  dueDate: Date,
  now: Date,
): EffectiveStatus {
  if (status === "PAGA") return "PAGA";
  if (status === "VENCIDA") return "VENCIDA";
  // PENDENTE (CANCELADA é filtrada na origem): vencida se passou do vencimento.
  return dueDate.getTime() < now.getTime() ? "VENCIDA" : "PENDENTE";
}

function addToBucket(b: StatusBucket, amount: number, eff: EffectiveStatus) {
  b.total += amount;
  b.count += 1;
  if (eff === "PAGA") b.pago += amount;
  else if (eff === "VENCIDA") b.vencido += amount;
  else b.pendente += amount;
}

export function aggregateFinanceReport(
  receivables: FinanceEntryInput[],
  payables: FinanceEntryInput[],
  range: { startDate: Date; endDate: Date },
  now: Date,
): FinanceReportResult {
  const receber = emptyBucket();
  const pagar = emptyBucket();
  const balcao = emptyBucket();
  const receberAvulso = emptyBucket();

  const methodMap = new Map<
    string | null,
    { receber: number; pagar: number }
  >();
  const dayMap = new Map<string, { receber: number; pagar: number }>();

  const bumpMethod = (
    m: string | null,
    kind: "receber" | "pagar",
    amt: number,
  ) => {
    const key = m ?? null;
    const e = methodMap.get(key) ?? { receber: 0, pagar: 0 };
    e[kind] += amt;
    methodMap.set(key, e);
  };
  const bumpDay = (d: Date, kind: "receber" | "pagar", amt: number) => {
    const key = toISODate(d);
    const e = dayMap.get(key) ?? { receber: 0, pagar: 0 };
    e[kind] += amt;
    dayMap.set(key, e);
  };

  for (const r of receivables) {
    if (r.status === "CANCELADA") continue;
    const eff = effectiveStatus(r.status, r.dueDate, now);
    addToBucket(receber, r.totalAmount, eff);
    if (r.hasItems) addToBucket(balcao, r.totalAmount, eff);
    else addToBucket(receberAvulso, r.totalAmount, eff);
    bumpMethod(r.paymentMethod, "receber", r.totalAmount);
    bumpDay(r.createdAt, "receber", r.totalAmount);
  }
  for (const p of payables) {
    if (p.status === "CANCELADA") continue;
    const eff = effectiveStatus(p.status, p.dueDate, now);
    addToBucket(pagar, p.totalAmount, eff);
    bumpMethod(p.paymentMethod, "pagar", p.totalAmount);
    bumpDay(p.createdAt, "pagar", p.totalAmount);
  }

  const byMethod = Array.from(methodMap.entries())
    .map(([method, v]) => ({ method, receber: v.receber, pagar: v.pagar }))
    .sort((a, b) => b.receber + b.pagar - (a.receber + a.pagar));

  // Série diária (zeros incluídos) por createdAt.
  const timeseries: FinanceReportResult["timeseries"] = [];
  const cur = new Date(
    Date.UTC(
      range.startDate.getUTCFullYear(),
      range.startDate.getUTCMonth(),
      range.startDate.getUTCDate(),
    ),
  );
  const last = new Date(
    Date.UTC(
      range.endDate.getUTCFullYear(),
      range.endDate.getUTCMonth(),
      range.endDate.getUTCDate(),
    ),
  );
  let guard = 0;
  while (cur <= last && guard < 800) {
    const key = toISODate(cur);
    const v = dayMap.get(key);
    timeseries.push({
      date: key,
      receber: v?.receber ?? 0,
      pagar: v?.pagar ?? 0,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }

  return {
    receber,
    pagar,
    balcao,
    receberAvulso,
    saldoPrevisto: receber.total - pagar.total,
    saldoRealizado: receber.pago - pagar.pago,
    byMethod,
    timeseries,
  };
}
