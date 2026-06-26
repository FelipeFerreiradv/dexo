/**
 * Helpers de exibição compartilhados pelas visões de Pedidos (tabela + vitrine).
 * Extraídos do `orders-list.tsx` original SEM mudança de comportamento, para
 * reuso entre `orders-table-view` e `order-card` (evita duplicar e evita editar
 * `components/ui/*`). O badge de status mantém o texto cru (PENDING/PAID/...),
 * idêntico à tabela de hoje; os rótulos pt-BR são usados só no Select de filtro.
 */

import { Badge } from "@/components/ui/badge";

export function getStatusBadge(status: string) {
  const variants: Record<
    string,
    "default" | "secondary" | "destructive" | "outline"
  > = {
    PENDING: "secondary",
    PAID: "default",
    SHIPPED: "outline",
    DELIVERED: "default",
    CANCELLED: "destructive",
  };
  return <Badge variant={variants[status] || "default"}>{status}</Badge>;
}

export function getPlatformLabel(platform: string) {
  switch (platform) {
    case "MERCADO_LIVRE":
      return "Mercado Livre";
    case "SHOPEE":
      return "Shopee";
    default:
      return platform;
  }
}

/**
 * Classes do badge de plataforma (ML amarelo / Shopee laranja) — exatamente as
 * mesmas do `orders-list.tsx` original. São cores de marca já existentes no
 * código, não cores novas hardcoded.
 */
export function platformBadgeClassName(platform?: string) {
  if (platform === "MERCADO_LIVRE") {
    return "border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";
  }
  if (platform === "SHOPEE") {
    return "border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-400";
  }
  return "";
}

/** Rótulos pt-BR de status — usados apenas no Select de filtros. */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendente",
  PAID: "Pago",
  SHIPPED: "Enviado",
  DELIVERED: "Entregue",
  CANCELLED: "Cancelado",
};
