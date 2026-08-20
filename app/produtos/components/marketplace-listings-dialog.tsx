"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MarketplaceListingPlatform } from "@/app/lib/marketplace-listing-links";
import { LISTING_PLATFORM_LABELS } from "@/app/produtos/lib/listing-status-labels";
import {
  ProductListingsList,
  useProductListings,
  type ListingEditContext,
  type ProductListingsRef,
} from "./product-listings-list";

export type { ListingEditContext };

/**
 * A busca, o cache e a lista vivem em `product-listings-list.tsx`, porque a
 * mesma lista também é renderizada dentro do modal de edição de produto (seção
 * "Anúncios deste produto"). Aqui sobrou só a casca do dialog — uma fonte de
 * verdade, dois hosts.
 */
export { invalidateListingsStatusCache } from "@/app/produtos/lib/listings-status-cache";

interface MarketplaceListingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductListingsRef | null;
  platform: MarketplaceListingPlatform | null;
  onEditProduct: () => void;
  onEditListing?: (ctx: ListingEditContext) => void;
  onToast?: (message: string, type: "success" | "error" | "warning") => void;
}

export function MarketplaceListingsDialog({
  open,
  onOpenChange,
  product,
  platform,
  onEditProduct,
  onEditListing,
  onToast: _onToast,
}: MarketplaceListingsDialogProps) {
  const platformLabel = platform ? LISTING_PLATFORM_LABELS[platform] : "";

  // `live=1`: este dialog é o lugar em que o operador vem justamente para
  // conferir o estado atual no marketplace, então vale o refresh remoto.
  const { listings, loading, error } = useProductListings({
    enabled: open && !!platform,
    productId: product?.id,
    platform,
    live: true,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {platformLabel
              ? `Anúncios publicados no ${platformLabel}`
              : "Anúncios publicados"}
          </DialogTitle>
          {product && (
            <DialogDescription>
              {product.sku ? `${product.sku} · ` : ""}
              {product.name}
            </DialogDescription>
          )}
        </DialogHeader>

        <ProductListingsList
          product={product}
          platform={platform}
          listings={listings}
          loading={loading}
          error={error}
          onEditListing={
            onEditListing
              ? (ctx) => {
                  // O dialog fecha a si mesmo — quem fecha é o host, nunca a
                  // lista (ela também roda embutida dentro de outro modal).
                  onOpenChange(false);
                  onEditListing(ctx);
                }
              : undefined
          }
          footer={
            <div className="flex justify-end pt-1">
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground"
                onClick={() => {
                  onOpenChange(false);
                  onEditProduct();
                }}
              >
                Editar dados do produto (afeta todos os anúncios)
              </Button>
            </div>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
