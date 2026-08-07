// PDV Balcão — estatísticas do dia calculadas no client a partir das vendas
// recentes já buscadas (GET /finance/receivables?hasItems=true). Módulo puro
// (sem imports) para ser testável em node (tests/pdv-stats.spec.ts).
//
// "Hoje" usa o dia LOCAL do caixa (getFullYear/getMonth/getDate), não UTC —
// o operador de balcão pensa no dia da loja.

export interface PdvSaleLike {
  status: string;
  totalAmount: number;
  paymentMethod: string | null;
  createdAt: string | Date;
  paidAt?: string | Date | null;
  // Bloco B — venda parcelada: `totalAmount` é só a ENTRADA. Este agregado das
  // parcelas entra no TAMANHO da venda (ticket médio), mas NUNCA no caixa do
  // dia: o saldo ainda não entrou. Ausente = venda à vista.
  installmentsAmount?: number;
}

export interface PdvMethodSlice {
  // Código de app/lib/payment-methods.ts ou null (venda sem forma informada).
  code: string | null;
  amount: number;
}

export interface PdvDayStats {
  // Caixa de hoje: soma das vendas PAGA com paidAt hoje.
  receivedToday: number;
  receivedTodayCount: number;
  // Vendas criadas hoje (qualquer status, exceto CANCELADA).
  salesTodayCount: number;
  salesTodayAmount: number;
  // Ticket médio das vendas criadas hoje (0 quando não houver).
  avgTicketToday: number;
  // Recebido hoje por forma de pagamento, ordenado por valor desc.
  byMethodToday: PdvMethodSlice[];
}

function sameLocalDay(value: string | Date | null | undefined, now: Date) {
  if (!value) return false;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function computePdvDayStats(
  rows: PdvSaleLike[],
  now: Date,
): PdvDayStats {
  let receivedToday = 0;
  let receivedTodayCount = 0;
  let salesTodayCount = 0;
  let salesTodayAmount = 0;
  const byMethod = new Map<string | null, number>();

  for (const r of rows) {
    const amount = Number(r.totalAmount) || 0;
    // TAMANHO da venda (inclui o saldo parcelado) × DINHEIRO QUE ENTROU (só a
    // entrada). São grandezas diferentes e cada card usa a sua: um ticket
    // médio de R$ 50 numa venda de R$ 131,11 engana quem opera o caixa, e
    // somar os R$ 81,11 no caixa de hoje seria pior ainda — eles não entraram.
    const saleSize = amount + (Number(r.installmentsAmount) || 0);

    if (r.status !== "CANCELADA" && sameLocalDay(r.createdAt, now)) {
      salesTodayCount += 1;
      salesTodayAmount += saleSize;
    }

    if (r.status === "PAGA" && sameLocalDay(r.paidAt ?? null, now)) {
      receivedToday += amount;
      receivedTodayCount += 1;
      const key = r.paymentMethod ?? null;
      byMethod.set(key, (byMethod.get(key) ?? 0) + amount);
    }
  }

  const byMethodToday = [...byMethod.entries()]
    .map(([code, amount]) => ({ code, amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    receivedToday,
    receivedTodayCount,
    salesTodayCount,
    salesTodayAmount,
    avgTicketToday: salesTodayCount > 0 ? salesTodayAmount / salesTodayCount : 0,
    byMethodToday,
  };
}
