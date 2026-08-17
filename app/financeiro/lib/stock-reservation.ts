// BLOCO G — estoque comprometido por venda pendente.
//
// O PROBLEMA, verificado no código: criar uma venda de balcão NÃO toca
// estoque. `FinanceRepository.createWithItems` faz exatamente três escritas
// (receivable, items, payments) e nenhuma delas é `product.update`. A baixa só
// acontece em `markPaid`. Enquanto a venda está PENDENTE, a peça continua com
// `stock` cheio, o anúncio continua vendável, e nada impede vender a mesma
// peça de novo — `validateItems` não lê estoque, o lookup do picker não filtra
// por estoque, e a UI mostra "Excede estoque" em âmbar sem bloquear o submit.
//
// Medido em produção (14/08): 65 vendas pendentes com itens; a mais antiga
// aberta há 51 DIAS. O FIADO é o caminho que mais alonga a janela, porque a
// cadeia do PDV não recebe automaticamente uma venda a prazo.
//
// ⚠️ O QUE ESTA FASE **NÃO** FAZ
// O sync continua empurrando `stock` CRU para os marketplaces. São 25 pontos
// de escrita (14 envios, 6 gates, 2 projeções, 2 filtros de pausa e 1 SQL
// bruto) contra 364 mil anúncios, e um deles — `syncProductData`, que roda em
// TODA edição de produto — reescreveria a quantidade bruta e desfaria a
// reserva em silêncio. Virar isso é fase própria, e por decisão de 14/08 ela
// acontece DEPOIS de existir medição de oversell (que hoje não existe: o
// `markPaid` descarta os `oversellAlerts` que o `deductWithinTx` devolve).
//
// Nesta fase a reserva é INFORMAÇÃO: aparece para o operador e alimenta o
// número que a próxima fase vai empurrar.
//
// Módulo PURO (sem I/O).

/**
 * Flag de BACKEND. Ausente ⇒ a coluna nunca é escrita e nenhum caminho de
 * venda muda de comportamento.
 */
export function isStockReservationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.STOCK_RESERVATION_ENABLED === "1";
}

// Referência literal a process.env.NEXT_PUBLIC_* para o Next inlinar.
const RESERVATION_UI_ENABLED =
  process.env.NEXT_PUBLIC_STOCK_RESERVATION_ENABLED === "true";

/** Reserva visível nas telas de produto e no seletor de peças? */
export function isStockReservationUiEnabled(): boolean {
  return RESERVATION_UI_ENABLED;
}

/**
 * Status em que a venda SEGURA a peça.
 *
 * PENDENTE e VENCIDA: a venda existe, o cliente espera a peça, e o estoque
 * ainda não baixou. PAGA não: ali o `stock` já foi decrementado de verdade, e
 * contar duas vezes tiraria a peça do mercado em dobro. CANCELADA não: acabou.
 */
export function reservesStock(status: string | null | undefined): boolean {
  return status === "PENDENTE" || status === "VENCIDA";
}

export interface ReservationItem {
  productId?: string | null;
  quantity: number;
}

/**
 * Quanto cada produto passa a ter comprometido por esta venda.
 *
 * Item MANUAL (sem `productId`) não reserva nada: não há peça de catálogo a
 * segurar. Quantidades do mesmo produto somam — a mesma peça pode aparecer em
 * duas linhas da venda.
 */
export function reservationOf(
  itens: ReservationItem[] | null | undefined,
  status: string | null | undefined,
): Map<string, number> {
  const mapa = new Map<string, number>();
  if (!reservesStock(status) || !Array.isArray(itens)) return mapa;
  for (const it of itens) {
    const id = it?.productId;
    if (!id) continue;
    const q = Number(it.quantity);
    if (!Number.isFinite(q) || q <= 0) continue;
    mapa.set(id, (mapa.get(id) ?? 0) + q);
  }
  return mapa;
}

/**
 * O DELTA a aplicar em `reservedStock`, indo do estado ANTES para o DEPOIS.
 *
 * É a peça central e por isso é pura: toda transição de venda passa por aqui —
 * criar (antes vazio), receber (depois vazio), cancelar (depois vazio),
 * excluir (depois vazio) e editar itens (os dois lados cheios). Uma única
 * função significa que nenhum caminho pode implementar a conta de um jeito
 * diferente, que é como um contador vira mentira.
 *
 * Devolve só o que MUDA: produto cujo comprometimento não mudou não entra no
 * mapa, e portanto não vira UPDATE.
 */
export function reservationDelta(
  antes: Map<string, number>,
  depois: Map<string, number>,
): Map<string, number> {
  const delta = new Map<string, number>();
  const ids = new Set<string>([...antes.keys(), ...depois.keys()]);
  for (const id of ids) {
    const d = (depois.get(id) ?? 0) - (antes.get(id) ?? 0);
    if (d !== 0) delta.set(id, d);
  }
  return delta;
}

/**
 * Quanto desta peça ainda pode ser vendido.
 *
 * Nunca negativo: uma reserva maior que o estoque significa que alguém vendeu
 * o que não tinha — e a resposta certa para "quanto posso vender" é ZERO, não
 * um número negativo que a tela mostraria como "-2 disponíveis".
 */
export function availableForSale(
  stock: number | null | undefined,
  reservedStock: number | null | undefined,
): number {
  const s = Number(stock) || 0;
  const r = Number(reservedStock) || 0;
  return Math.max(0, s - r);
}

/**
 * A peça está comprometida ALÉM do que existe fisicamente?
 *
 * É o sinal de que a venda dupla já aconteceu. Enquanto o sync não considerar
 * a reserva, este é o único jeito de VER o problema — e é o que a próxima fase
 * vai usar para decidir se a virada valeu.
 */
export function isOverReserved(
  stock: number | null | undefined,
  reservedStock: number | null | undefined,
): boolean {
  return (Number(reservedStock) || 0) > (Number(stock) || 0);
}

/** Texto curto para a tela: "3 em estoque · 1 reservada". */
export function describeAvailability(
  stock: number | null | undefined,
  reservedStock: number | null | undefined,
): string {
  const s = Number(stock) || 0;
  const r = Number(reservedStock) || 0;
  if (r <= 0) return `${s} em estoque`;
  return `${s} em estoque · ${r} reservada${r === 1 ? "" : "s"}`;
}
