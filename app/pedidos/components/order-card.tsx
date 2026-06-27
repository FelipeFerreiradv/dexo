"use client";

import { useState } from "react";
import Image from "next/image";
import { Package, MapPin, Store } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { Order } from "@/app/interfaces/order.interface";
import {
  getPlatformLabel,
  getStatusBadge,
  platformBadgeClassName,
} from "../lib/order-badges";

const formatCurrency = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

interface OrderCardProps {
  order: Order;
  onView: (order: Order) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

/**
 * Card-vitrine de um pedido: foto do 1º item como herói + nome/SKU/localização,
 * status, plataforma + nome da conta, cliente, total e data. Foto via
 * `next/image` (otimizador global desligado) com fallback neutro (`Package`)
 * quando não há imagem ou ela falha. Card inteiro clicável e acessível.
 */
export function OrderCard({
  order,
  onView,
  selectable,
  selected,
  onToggleSelect,
}: OrderCardProps) {
  const [imgError, setImgError] = useState(false);
  const thumb = order.thumbnail;
  const itemCount = order.itemCount ?? 0;
  const extraItems = itemCount > 1 ? itemCount - 1 : 0;
  const productName = thumb?.name ?? "Pedido sem itens vinculados";
  const showImage = Boolean(thumb?.imageUrl) && !imgError;

  const activate = () => onView(order);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Ver pedido ${order.externalOrderId}`}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
      className="group flex cursor-pointer flex-col rounded-2xl border border-border/60 bg-card/80 p-3 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur transition hover:-translate-y-0.5 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted">
        {selectable ? (
          <div
            role="presentation"
            className="absolute left-2 top-2 z-10"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={!!selected}
              onCheckedChange={() => onToggleSelect?.(order.id)}
              aria-label={`Selecionar pedido ${order.externalOrderId}`}
              className="border-border/70 bg-card/90 shadow"
            />
          </div>
        ) : null}
        {showImage ? (
          <Image
            src={thumb!.imageUrl as string}
            alt={productName}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            className="object-cover transition-transform duration-300 group-hover:scale-105"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="size-8 text-muted-foreground" />
          </div>
        )}
        {extraItems > 0 ? (
          <span className="absolute right-2 top-2 rounded-full border border-border/60 bg-card/90 px-2 py-0.5 text-xs font-medium text-foreground backdrop-blur">
            +{extraItems} {extraItems === 1 ? "item" : "itens"}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-1 flex-col gap-2">
        <p
          className="line-clamp-2 text-sm font-semibold leading-snug text-foreground"
          title={productName}
        >
          {productName}
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {thumb?.location ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-medium text-foreground">
              <MapPin className="size-3 text-muted-foreground" />
              {thumb.location}
            </span>
          ) : null}
          {thumb?.sku ? <span className="font-mono">{thumb.sku}</span> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {getStatusBadge(order.status)}
          <Badge
            variant="outline"
            className={platformBadgeClassName(
              order.marketplaceAccount?.platform,
            )}
          >
            {getPlatformLabel(order.marketplaceAccount?.platform || "—")}
          </Badge>
        </div>

        {order.marketplaceAccount?.accountName ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Store className="size-3" />
            {order.marketplaceAccount.accountName}
          </span>
        ) : null}

        <div className="mt-auto border-t border-border/60 pt-2">
          <div className="flex items-center justify-between gap-2">
            <span
              className="truncate text-sm text-foreground"
              title={order.customerName ?? undefined}
            >
              {order.customerName || "Cliente não informado"}
            </span>
            <span className="shrink-0 text-sm font-semibold text-foreground">
              {formatCurrency(order.totalAmount)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">#{order.externalOrderId}</span>
            <span className="shrink-0">
              {new Date(order.createdAt).toLocaleDateString("pt-BR")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
