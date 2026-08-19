// BLOCO A, 2ª METADE — liquidação: o dinheiro CAIU ou ainda está a caminho?
//
// O sistema confundia duas coisas num campo só. `paidAt` é gravado como
// `new Date()` no `markPaid` (finance.usecase.ts:701) e significa "a venda foi
// baixada, o estoque saiu". Para PIX, dinheiro e débito isso coincide com "o
// dinheiro entrou". Para crédito e boleto, não coincide — e é justamente aí
// que o caixa do dia mente.
//
// ⚠️ ESTA DIMENSÃO NÃO TOCA NENHUM DOS 8 LUGARES QUE SOMAM DINHEIRO HOJE.
// Existe UMA única fórmula de "quanto entrou" no produto inteiro
// (`SUM(Receivable.totalAmount) WHERE status='PAGA'`), repetida em summary,
// dashboard, PDV e relatórios. Decisão de 14/08: a liquidação é MÉTRICA NOVA
// AO LADO. Cada número existente continua significando o que sempre
// significou, e quem quiser a visão de caixa real lê os dois.
//
// O DESENHO É DERIVAÇÃO, NÃO ESCRITA
// A regra por forma (decisão de 14/08) permite responder sem gravar nada no
// caso comum: PIX liquida no ato, crédito não. Só a EXCEÇÃO — "o dinheiro do
// cartão caiu hoje" — precisa de uma escrita. É a mesma economia do `VENCIDA`,
// que nunca foi persistido.
//
// Módulo PURO (sem I/O).

/**
 * Formas em que o dinheiro entra NO ATO da baixa.
 *
 * TRANSFERENCIA entra aqui porque no balcão ela é conferida na hora (o
 * operador vê o comprovante); se algum dia virar TED agendada, sai da lista —
 * e sair da lista é editar esta linha, sem migração.
 *
 * Fora: CREDITO e BOLETO (caem depois) e FIADO, que não é forma de pagamento
 * recebida e sim venda a prazo — a conta fica PENDENTE e nem chega aqui.
 */
const LIQUIDACAO_IMEDIATA = new Set([
  "DINHEIRO",
  "PIX",
  "DEBITO",
  "TRANSFERENCIA",
]);

/** A forma entrega o dinheiro no ato da baixa? */
export function settlesImmediately(method: string | null | undefined): boolean {
  return !!method && LIQUIDACAO_IMEDIATA.has(method);
}

/**
 * Flag de BACKEND. Ausente ⇒ nada é gravado nas colunas novas e nenhuma
 * métrica nova é exposta.
 */
export function isSettlementEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SALE_SETTLEMENT_ENABLED === "1";
}

// Referência literal a process.env.NEXT_PUBLIC_* para o Next inlinar.
const SETTLEMENT_UI_ENABLED =
  process.env.NEXT_PUBLIC_SALE_SETTLEMENT_ENABLED === "true";

/** Selo "a liquidar" e ação de marcar visíveis? Exige `npm run build`. */
export function isSettlementUiEnabled(): boolean {
  return SETTLEMENT_UI_ENABLED;
}

export interface SettlementSale {
  status: string | null | undefined;
  paidAt: Date | string | null | undefined;
  paymentMethod?: string | null;
  /** Marca EXPLÍCITA de que o dinheiro caiu. Precede qualquer derivação. */
  settledAt?: Date | string | null;
}

export interface SettlementLine {
  method: string;
  amount: number;
  settledAt?: Date | string | null;
}

function comoData(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Quando o dinheiro DESTA LINHA caiu. `null` = ainda a caminho.
 *
 * Ordem, e ela importa:
 *  1. marca EXPLÍCITA na linha — alguém conferiu o extrato e disse que caiu;
 *  2. venda não baixada ⇒ nada caiu, qualquer que seja a forma;
 *  3. forma de liquidação imediata ⇒ caiu junto com a baixa (`paidAt`);
 *  4. resto (crédito, boleto) ⇒ a liquidar.
 */
export function lineSettledAt(
  line: SettlementLine,
  venda: SettlementSale,
): Date | null {
  const explicito = comoData(line.settledAt);
  if (explicito) return explicito;
  if (venda.status !== "PAGA") return null;
  if (!settlesImmediately(line.method)) return null;
  return comoData(venda.paidAt);
}

/**
 * Quando o dinheiro da VENDA caiu, para as vendas SEM linhas de pagamento.
 *
 * É o caso da esmagadora maioria: medido em 14/08, só 5 das 82 vendas com
 * forma têm linhas. Sem este caminho, a métrica enxergaria 6% da realidade.
 */
export function saleSettledAt(venda: SettlementSale): Date | null {
  const explicito = comoData(venda.settledAt);
  if (explicito) return explicito;
  if (venda.status !== "PAGA") return null;
  if (!settlesImmediately(venda.paymentMethod)) return null;
  return comoData(venda.paidAt);
}

export interface SettlementBreakdown {
  /** Já caiu. */
  settledAmount: number;
  /** Baixado, mas o dinheiro ainda não entrou. */
  pendingAmount: number;
}

/**
 * Quanto desta venda já caiu e quanto ainda está a caminho.
 *
 * COM linhas, cada forma decide sozinha — é o "PIX caiu, cartão não" da mesma
 * venda. SEM linhas, a venda inteira decide pela forma predominante.
 *
 * Venda não PAGA devolve zero nos dois: dinheiro que nem foi cobrado não é
 * "a liquidar", é "a receber" — e isso o `pendingAmount` do resumo já conta.
 * Misturar os dois faria o mesmo real aparecer em duas métricas.
 */
export function settlementBreakdown(
  venda: SettlementSale,
  linhas: SettlementLine[] | null | undefined,
  totalAmount: number,
): SettlementBreakdown {
  if (venda.status !== "PAGA") {
    return { settledAmount: 0, pendingAmount: 0 };
  }

  const lista = Array.isArray(linhas) ? linhas : [];
  if (lista.length === 0) {
    const caiu = saleSettledAt(venda) !== null;
    const valor = Number(totalAmount) || 0;
    return caiu
      ? { settledAmount: valor, pendingAmount: 0 }
      : { settledAmount: 0, pendingAmount: valor };
  }

  let settledAmount = 0;
  let pendingAmount = 0;
  for (const l of lista) {
    const valor = Number(l.amount) || 0;
    if (lineSettledAt(l, venda) !== null) settledAmount += valor;
    else pendingAmount += valor;
  }
  // Centavos: as somas parciais são de Decimal convertido, e arredondar aqui
  // evita que 0.1 + 0.2 apareça como 0.30000000000000004 numa tela de dinheiro.
  return {
    settledAmount: Math.round(settledAmount * 100) / 100,
    pendingAmount: Math.round(pendingAmount * 100) / 100,
  };
}

/** A venda tem algum valor ainda a cair? Serve ao selo da listagem. */
export function hasPendingSettlement(
  venda: SettlementSale,
  linhas: SettlementLine[] | null | undefined,
  totalAmount: number,
): boolean {
  return settlementBreakdown(venda, linhas, totalAmount).pendingAmount > 0;
}

/**
 * Fronteira de tipo do PATCH de liquidação.
 *
 * `true` ⇒ marcar que caiu AGORA; `false` ⇒ desmarcar (voltar a "a liquidar",
 * porque conferência de extrato erra e erro precisa ter volta).
 * `undefined` quando não dá para aceitar — a rota responde 400.
 */
export function normalizeSettleFlag(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean | undefined {
  if (!isSettlementEnabled(env)) return undefined;
  if (typeof value !== "boolean") return undefined;
  return value;
}
