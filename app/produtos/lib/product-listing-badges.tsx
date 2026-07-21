"use client";

// Helpers de exibição compartilhados pelas visões de Produtos (Lista + Catálogo).
// Extraídos 1:1 de `products-list.tsx` SEM mudança de comportamento, para reuso
// entre `products-list-view` e `product-card` (evita duplicar e evita editar
// `components/ui/*`). Espelha o padrão de `app/pedidos/lib/order-badges.tsx`.

import { useMemo } from "react";
import { Loader2, Pause, PauseCircle, Play } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MARKETPLACE_LISTING_PLATFORMS,
  resolveMarketplaceListingLinkState,
} from "@/app/lib/marketplace-listing-links";
import type {
  MarketplacePlatform,
  Product,
  ProductPauseState,
} from "./product-view-types";

const MARKETPLACE_ICONS: Record<
  MarketplacePlatform,
  { label: string; src: string }
> = {
  MERCADO_LIVRE: {
    label: "Mercado Livre",
    src: "/marketplaces/mercado-livre.svg",
  },
  SHOPEE: {
    label: "Shopee",
    src: "/marketplaces/shopee.svg",
  },
  MAGALU: {
    label: "Magalu",
    src: "/marketplaces/magalu.svg",
  },
  OLX: {
    label: "OLX",
    src: "/marketplaces/olx.svg",
  },
  FACEBOOK: {
    label: "Facebook",
    src: "/marketplaces/facebook.svg",
  },
};

// Considera "ativo" os mesmos statuses que ACTIVE_LISTING_STATUSES de
// app/lib/marketplace-listing-links.ts ("active" e "normal"). "paused"/"unlist"
// contam como pausado. Outros (under_review, error) caem em no-actionable.
// Terminais (closed/deleted/seller_deleted) são NEUTROS: o anúncio não existe
// mais no marketplace, então não pode entrar no cômputo — com o espelhamento
// de status ligado, um produto com anúncio ativo + um encerrado precisa
// continuar mostrando o botão de pausar o ativo.
const TERMINAL_LISTING_STATUSES = new Set([
  "closed",
  "deleted",
  "seller_deleted",
]);

export function computeProductPauseState(
  listings: Product["listings"],
): ProductPauseState {
  if (!listings || listings.length === 0) return "no-actionable";

  const publishable = listings.filter(
    (l) =>
      l.externalListingId &&
      !l.externalListingId.startsWith("PENDING_") &&
      !TERMINAL_LISTING_STATUSES.has(l.status?.toLowerCase() ?? ""),
  );

  if (publishable.length === 0) return "no-actionable";

  let active = 0;
  let paused = 0;
  for (const l of publishable) {
    const s = l.status?.toLowerCase();
    if (s === "active" || s === "normal") active++;
    else if (s === "paused" || s === "unlist") paused++;
  }

  if (active === publishable.length) return "all-active";
  if (paused === publishable.length) return "all-paused";
  if (active > 0 && paused > 0) return "mixed";

  return "no-actionable";
}

export function PauseListingsButton({
  product,
  state,
  isPausing,
  onTogglePause,
}: {
  product: Product;
  state: ProductPauseState;
  isPausing: boolean;
  onTogglePause: (product: Product, status: "active" | "paused") => void;
}) {
  if (state === "no-actionable") return null;

  if (state === "mixed") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Pausar/Despausar anúncios"
            disabled={isPausing}
          >
            {isPausing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PauseCircle className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onTogglePause(product, "paused")}>
            <Pause className="mr-2 size-4" />
            Pausar todos
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onTogglePause(product, "active")}>
            <Play className="mr-2 size-4" />
            Despausar todos
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const targetStatus: "active" | "paused" =
    state === "all-active" ? "paused" : "active";
  const Icon = state === "all-active" ? Pause : Play;
  const title =
    state === "all-active" ? "Pausar anúncios" : "Despausar anúncios";
  const confirmLabel = state === "all-active" ? "Pausar" : "Despausar";
  const description =
    state === "all-active"
      ? `Pausar todos os anúncios publicados de "${product.name}"? Eles ficarão invisíveis nos marketplaces até serem despausados.`
      : `Reativar todos os anúncios publicados de "${product.name}"? Eles voltarão a aparecer nos marketplaces.`;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={title}
          disabled={isPausing}
        >
          {isPausing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Icon className="size-4" />
          )}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`${confirmLabel} anúncios?`}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onTogglePause(product, targetStatus)}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function MarketplaceBadges({
  listings,
  size = "md",
  onOpenListings,
}: {
  listings?: Product["listings"];
  size?: "sm" | "md";
  onOpenListings?: (platform: MarketplacePlatform) => void;
}) {
  const groupedByPlatform = useMemo(() => {
    const map = new Map<
      MarketplacePlatform,
      { count: number; anyOpenable: boolean; anyActive: boolean }
    >();

    for (const listing of listings ?? []) {
      if (!listing) continue;
      const platform = listing.platform as MarketplacePlatform | undefined;
      if (!platform || !MARKETPLACE_LISTING_PLATFORMS.includes(platform)) {
        continue;
      }
      const current = map.get(platform) ?? {
        count: 0,
        anyOpenable: false,
        anyActive: false,
      };
      current.count += 1;
      if (
        !current.anyOpenable &&
        resolveMarketplaceListingLinkState(listing).isOpenable
      ) {
        current.anyOpenable = true;
      }
      // Status "publicado" (active/normal) — usado só para a OPACIDADE da Magalu,
      // que não tem link público derivável (publicação assíncrona).
      const st = (listing as { status?: string | null }).status
        ?.toString()
        .toLowerCase();
      if (!current.anyActive && (st === "active" || st === "normal")) {
        current.anyActive = true;
      }
      map.set(platform, current);
    }

    return MARKETPLACE_LISTING_PLATFORMS.flatMap((platform) => {
      const entry = map.get(platform);
      return entry ? [{ platform, ...entry }] : [];
    });
  }, [listings]);

  if (groupedByPlatform.length === 0) return null;

  const imgClass = size === "sm" ? "h-4 w-auto" : "h-5 w-auto";
  const chipClass =
    size === "sm"
      ? "inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-[2px]"
      : "inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1";
  const interactiveClass =
    "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  const dimmedClass = "opacity-60";

  return (
    <div className="flex items-center gap-2">
      {groupedByPlatform.map(({ platform, count, anyOpenable, anyActive }) => {
        const icon = MARKETPLACE_ICONS[platform];
        const title =
          count > 1
            ? `${count} anúncios publicados no ${icon.label}`
            : `Anúncio publicado no ${icon.label}`;

        // Opacidade = "publicado". ML/Shopee: têm link quando publicados
        // (anyOpenable). Magalu: publicação é assíncrona e a URL pública não é
        // derivável do SKU, então o sinal é o STATUS active/normal. ML/Shopee
        // ficam idênticos (não entram no ramo MAGALU).
        const isPublished = anyOpenable || (platform === "MAGALU" && anyActive);

        return (
          <button
            key={platform}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenListings?.(platform);
            }}
            className={`${chipClass} ${interactiveClass} ${
              isPublished ? "" : dimmedClass
            }`}
            title={title}
            aria-label={title}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={icon.src} alt={icon.label} className={imgClass} />
            {count > 1 && (
              <span className="text-xs font-medium leading-none text-muted-foreground">
                {count}
              </span>
            )}
            <span className="sr-only">{icon.label}</span>
          </button>
        );
      })}
    </div>
  );
}
