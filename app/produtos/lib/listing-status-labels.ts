import type { MarketplaceListingPlatform } from "@/app/lib/marketplace-listing-links";

export type ListingStatusBadgeVariant =
  | "success"
  | "warning"
  | "destructive"
  | "secondary";

export const LISTING_STATUS_LABELS: Record<
  string,
  { label: string; variant: ListingStatusBadgeVariant }
> = {
  active: { label: "Ativo", variant: "success" },
  normal: { label: "Ativo", variant: "success" },
  paused: { label: "Pausado", variant: "warning" },
  unlist: { label: "Pausado", variant: "warning" },
  pending: { label: "Pendente", variant: "secondary" },
  reviewing: { label: "Em revisão", variant: "secondary" },
  closed: { label: "Fechado", variant: "destructive" },
  deleted: { label: "Excluído", variant: "destructive" },
  seller_deleted: { label: "Excluído", variant: "destructive" },
  inactive: { label: "Inativo", variant: "destructive" },
  error: { label: "Erro", variant: "destructive" },
  banned: { label: "Banido", variant: "destructive" },
};

export const LISTING_PLATFORM_LABELS: Record<MarketplaceListingPlatform, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
};

export function getListingStatusBadge(status?: string | null) {
  const key = (status ?? "").toLowerCase();
  return (
    LISTING_STATUS_LABELS[key] ?? {
      label: status ?? "Desconhecido",
      variant: "secondary" as ListingStatusBadgeVariant,
    }
  );
}

const listingDateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatListingDateTime(value?: string | Date | null) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return listingDateTimeFormatter.format(date);
}
