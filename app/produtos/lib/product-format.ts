// Helpers de formatação compartilhados pelas visões de Produtos (Lista + Catálogo).
// Extraídos 1:1 de `products-list.tsx` (eram closures dentro do componente), sem
// mudança de comportamento.

export const formatPrice = (price: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(price);

export const formatDate = (dateString: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(dateString));

export const getStockBadgeVariant = (stock: number) => {
  if (stock === 0) return "destructive";
  if (stock <= 10) return "warning";
  return "success";
};

// ── BLOCO G: o que a tela mostra quando há peça comprometida ────────────────
//
// O PROBLEMA QUE ISTO FECHA, com caso real: peça de 1 unidade vendida FIADO em
// 28/08. A reserva foi gravada em 54 ms e o disponível virou 0 — mas o card do
// catálogo seguiu dizendo "1 un.", porque desenhava `Product.stock`, o estoque
// FÍSICO. Quem olhou a tela concluiu que a venda não tinha baixado nada.
//
// `stock` continua sendo o físico (a peça pode estar no pátio esperando o
// cliente buscar, e a baixa real é do `markPaid`). O que a tela precisa
// responder não é "quantas peças existem", e sim "quantas ainda posso vender".
//
// Centralizado aqui, e não repetido nos 8 pontos de render, porque oito cópias
// de uma regra são oito chances de uma divergir — e a que divergir vira
// justamente o número errado numa tela que ninguém olhou.

import {
  availableForSale,
  describeAvailability,
  isStockReservationUiEnabled,
} from "@/app/financeiro/lib/stock-reservation";

export interface StockDisplay {
  /** O número a exibir: o DISPONÍVEL quando há reserva, senão o estoque. */
  value: number;
  /** Sufixo do badge: "disponível" quando há reserva, senão "un.". */
  suffix: string;
  /** "1 em estoque · 1 reservada" — `null` quando não há reserva a explicar. */
  detail: string | null;
  /** Há peça comprometida? Serve para a tela decidir se mostra o detalhe. */
  hasReserved: boolean;
}

/**
 * Decide o que a tela mostra para um produto.
 *
 * Sem reserva (0, `null` ou campo ausente) ⇒ `{ value: stock, suffix: "un." }`,
 * exatamente o que as telas desenhavam antes desta mudança. É o que mantém a
 * regressão em zero para a esmagadora maioria do catálogo.
 *
 * Flag de UI desligada ⇒ idem, mesmo com a coluna preenchida.
 */
export function getStockDisplay(
  stock: number,
  reservedStock?: number | null,
): StockDisplay {
  const reserved = Number(reservedStock) || 0;
  const hasReserved = isStockReservationUiEnabled() && reserved > 0;

  if (!hasReserved) {
    return { value: stock, suffix: "un.", detail: null, hasReserved: false };
  }

  return {
    value: availableForSale(stock, reserved),
    suffix: "disponível",
    detail: describeAvailability(stock, reserved),
    hasReserved: true,
  };
}
