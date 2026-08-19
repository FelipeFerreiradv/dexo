"use client";

import { useState } from "react";
import Image from "next/image";
import {
  Eye,
  MapPin,
  Package,
  Pencil,
  ShoppingCart,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import type { MarketplacePlatform, Product } from "../lib/product-view-types";
import { formatPrice, getStockBadgeVariant } from "../lib/product-format";
import {
  computeProductPauseState,
  MarketplaceBadges,
  PauseListingsButton,
} from "../lib/product-listing-badges";

interface ProductCardProps {
  product: Product;
  selected: boolean;
  isPausing: boolean;
  isBulkDeleting: boolean;
  isBulkPausing: boolean;
  onToggleSelect: (id: string, checked: boolean | "indeterminate") => void;
  onView: (product: Product) => void;
  onEdit: (product: Product) => void;
  onDelete: (id: string) => void;
  onTogglePause: (product: Product, status: "active" | "paused") => void;
  onOpenLightbox: (product: Product) => void;
  onOpenListings: (product: Product, platform: MarketplacePlatform) => void;
  /**
   * BLOCO I — "Vender no PDV". AUSENTE ⇒ o botão não existe e o card renderiza
   * exatamente como hoje. A navegação é do pai (que tem o router); o card
   * segue presentacional, como todas as outras ações dele.
   */
  onSell?: (product: Product) => void;
}

/**
 * Card-vitrine de um produto (visão "Catálogo"). Funcionalmente equivalente à
 * linha/card da visão "Lista" — seleção, badges de marketplace, lightbox e as
 * ações ver/editar/pausar/excluir — com layout de vitrine e-commerce (espelha
 * `app/pedidos/components/order-card.tsx`). O card NÃO é clicável como um todo:
 * só a foto (→ lightbox) e os controles explícitos têm ação. Foto via
 * `next/image` (otimizador global desligado) com fallback neutro (`Package`).
 */
export function ProductCard({
  product,
  selected,
  isPausing,
  isBulkDeleting,
  isBulkPausing,
  onToggleSelect,
  onView,
  onEdit,
  onDelete,
  onTogglePause,
  onOpenLightbox,
  onOpenListings,
  onSell,
}: ProductCardProps) {
  const [imgError, setImgError] = useState(false);
  const showImage = Boolean(product.imageUrl) && !imgError;
  const location =
    product.locationPath ?? product.productLocation?.code ?? product.location;

  return (
    <div
      className={`group flex flex-col rounded-2xl border bg-card/80 p-3 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur transition hover:-translate-y-0.5 hover:border-primary/40 ${
        selected ? "border-primary ring-2 ring-primary" : "border-border/60"
      }`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted">
        {showImage ? (
          <button
            type="button"
            onClick={() => onOpenLightbox(product)}
            title="Ampliar imagem"
            aria-label={`Ampliar imagem de ${product.name}`}
            className="absolute inset-0 h-full w-full bg-transparent"
          >
            <Image
              src={product.imageUrl as string}
              alt={product.name}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              onError={() => setImgError(true)}
            />
          </button>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="size-8 text-muted-foreground" />
          </div>
        )}

        <div
          role="presentation"
          className="absolute left-2 top-2 z-10"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onToggleSelect(product.id, checked)}
            aria-label={`Selecionar ${product.name}`}
            disabled={isBulkDeleting || isBulkPausing}
            className="border-border/70 bg-card/90 shadow"
          />
        </div>

        {product.createdFromMarketplace && product.originPlatform && (
          <span className="absolute right-2 top-2 z-10 rounded-full border border-border/60 bg-card/90 px-2 py-0.5 text-xs font-medium text-foreground backdrop-blur">
            Origem: Anúncio{" "}
            {product.originPlatform === "SHOPEE"
              ? "Shopee"
              : product.originPlatform === "MAGALU"
                ? "Magalu"
                : product.originPlatform === "OLX"
                  ? "OLX"
                  : product.originPlatform === "FACEBOOK"
                    ? "Facebook"
                    : "Mercado Livre"}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-1 flex-col gap-2">
        <p
          className="line-clamp-2 text-sm font-semibold leading-snug text-foreground"
          title={product.name}
        >
          {product.name}
        </p>
        <p className="font-mono text-xs text-muted-foreground">{product.sku}</p>

        <MarketplaceBadges
          listings={product.listings}
          size="sm"
          onOpenListings={(platform) => onOpenListings(product, platform)}
        />

        <div className="flex flex-wrap items-center gap-2">
          {location ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground">
              <MapPin className="size-3 text-muted-foreground" />
              {location}
            </span>
          ) : null}
          <Badge
            variant={getStockBadgeVariant(product.stock)}
            className="ml-auto"
          >
            {product.stock} un.
          </Badge>
        </div>

        <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-2">
          <span className="font-mono text-base font-semibold tabular-nums text-foreground">
            {formatPrice(product.price)}
          </span>
          <div className="flex gap-1">
            {/* BLOCO I — vender esta peça no balcão. Vem primeiro por ser a
                ação comercial da vitrine; as outras são de manutenção.
                NÃO é desabilitado por estoque zero de propósito: a casa avisa
                em vez de bloquear (o bloco de itens do PDV já mostra "Excede
                estoque"), e num desmanche a peça às vezes está no pátio antes
                de estar na contagem. */}
            {onSell && (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Vender no PDV Balcão"
                onClick={() => onSell(product)}
              >
                <ShoppingCart className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Ver detalhes"
              onClick={() => onView(product)}
            >
              <Eye className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Editar"
              onClick={() => onEdit(product)}
            >
              <Pencil className="size-4" />
            </Button>

            <PauseListingsButton
              product={product}
              state={computeProductPauseState(product.listings)}
              isPausing={isPausing}
              onTogglePause={onTogglePause}
            />

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon-sm" title="Excluir">
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Excluir produto?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {`Tem certeza que deseja excluir o produto "${product.name}"? Esta ação é irreversível.`}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => onDelete(product.id)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Excluir
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </div>
  );
}
