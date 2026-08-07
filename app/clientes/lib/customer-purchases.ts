// Clientes — Bloco C: histórico de compras da ficha do cliente.
//
// LEITURA PURA. Nada aqui cria, edita ou apaga nada: são os endpoints que já
// existem (`GET /finance/receivables` com os filtros `customerId` + `hasItems`,
// que já estavam prontos no backend e simplesmente não tinham UI, e o
// `GET /finance/receivables/:id` da edição, para os itens sob demanda).
//
// Toda a UI fica atrás de NEXT_PUBLIC_CUSTOMER_PURCHASE_HISTORY_ENABLED.
// Flag ausente ⇒ /clientes renderiza EXATAMENTE como hoje.

import { getApiBaseUrl } from "@/lib/api";

const PURCHASE_HISTORY_ENABLED =
  process.env.NEXT_PUBLIC_CUSTOMER_PURCHASE_HISTORY_ENABLED === "true";

export function isPurchaseHistoryEnabled(): boolean {
  return PURCHASE_HISTORY_ENABLED;
}

/**
 * Egress: 10 por página. O histórico é para consulta pontual no balcão
 * ("o que esse cliente comprou?"), não um dump da base — regra da casa.
 */
export const PURCHASES_PAGE_SIZE = 10;

export type PurchaseStatus = "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";

export interface PurchaseRow {
  id: string;
  totalAmount: number;
  status: PurchaseStatus;
  paymentMethod: string | null;
  /** Resumo dos itens gerado pelo ProductPickerBlock ("Farol e mais 2 itens"). */
  reason: string | null;
  createdAt: string;
  paidAt?: string | null;
  dueDate?: string | null;
}

export interface PurchaseItem {
  id: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  product?: { id: string; sku: string; name: string } | null;
}

export interface PurchasesPage {
  rows: PurchaseRow[];
  total: number;
  totalPages: number;
}

export interface PurchasesTotals {
  /** Compras registradas (qualquer status, exceto o que o backend já exclui). */
  count: number;
  /** Somatório das compras efetivamente PAGAS — o "quanto esse cliente já gastou". */
  paidAmount: number;
  /** Em aberto (PENDENTE) — crediário/fiado a receber deste cliente. */
  pendingAmount: number;
  /** Vencido (PENDENTE|VENCIDA com vencimento no passado). */
  overdueAmount: number;
}

/**
 * Compras (vendas balcão) de um cliente, paginadas.
 *
 * `hasItems=true` é o que separa VENDA de cobrança avulsa — é a mesma regra que
 * o PDV usa no livro do dia e que o relatório usa para o split Balcão × avulso
 * (finance-report.ts:109-110). Sem ele, uma taxa ou um serviço lançado como
 * conta a receber apareceria como se fosse compra de peça.
 */
export async function fetchCustomerPurchases(
  customerId: string,
  email: string,
  page: number,
  signal?: AbortSignal,
): Promise<PurchasesPage> {
  const params = new URLSearchParams({
    customerId,
    hasItems: "true",
    page: String(page),
    limit: String(PURCHASES_PAGE_SIZE),
  });
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables?${params}`,
    { headers: { email }, signal },
  );
  if (!res.ok) throw new Error("Erro ao buscar as compras do cliente");
  const data = await res.json();
  return {
    rows: (data.items ?? []) as PurchaseRow[],
    total: data.pagination?.total ?? 0,
    totalPages: data.pagination?.totalPages ?? 1,
  };
}

/**
 * Totais do cliente. Reusa `GET /finance/summary`, que passou a aceitar
 * `customerId` (aditivo — sem o parâmetro o resumo é byte-idêntico ao atual).
 *
 * NUNCA lança: os totais são um enfeite do cabeçalho; se falharem, a lista de
 * compras — que é o conteúdo de verdade — não pode deixar de aparecer.
 */
export async function fetchCustomerTotals(
  customerId: string,
  email: string,
  signal?: AbortSignal,
): Promise<PurchasesTotals | null> {
  try {
    const params = new URLSearchParams({ customerId, hasItems: "true" });
    const res = await fetch(`${getApiBaseUrl()}/finance/summary?${params}`, {
      headers: { email },
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data?.summary?.receivables;
    if (!r) return null;
    return {
      count: Number(r.totalCount ?? 0),
      paidAmount: Number(r.paidAmount ?? 0),
      pendingAmount: Number(r.pendingAmount ?? 0),
      overdueAmount: Number(r.overdueAmount ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Itens de uma compra — SOB DEMANDA (só quando a linha é expandida).
 *
 * A listagem não traz itens de propósito (egress: finance.repository.ts:428).
 * Buscar de todas as linhas ao abrir o painel seria um N+1 de 10 requests para
 * um dado que o operador quase nunca abre.
 */
export async function fetchPurchaseItems(
  receivableId: string,
  email: string,
): Promise<PurchaseItem[]> {
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables/${receivableId}`,
    { headers: { email } },
  );
  if (!res.ok) throw new Error("Erro ao carregar os itens da compra");
  const data = await res.json();
  return (data?.entry?.items ?? []) as PurchaseItem[];
}
