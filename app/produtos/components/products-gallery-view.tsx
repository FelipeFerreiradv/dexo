"use client";

import { useMemo } from "react";

import type { MarketplacePlatform, Product } from "../lib/product-view-types";
import { ProductCard } from "./product-card";

interface ProductsGalleryViewProps {
  products: Product[];
  selectedIds: string[];
  pausingIds: Set<string>;
  isBulkDeleting: boolean;
  isBulkPausing: boolean;
  onToggleSelectOne: (id: string, checked: boolean | "indeterminate") => void;
  onView: (product: Product) => void;
  onEdit: (product: Product) => void;
  onDelete: (id: string) => void;
  onTogglePause: (product: Product, status: "active" | "paused") => void;
  onOpenLightbox: (product: Product) => void;
  onOpenListings: (product: Product, platform: MarketplacePlatform) => void;
}

/** Vitrine de produtos: grade responsiva de `ProductCard` (1 → 4 colunas). */
export function ProductsGalleryView({
  products,
  selectedIds,
  pausingIds,
  isBulkDeleting,
  isBulkPausing,
  onToggleSelectOne,
  onView,
  onEdit,
  onDelete,
  onTogglePause,
  onOpenLightbox,
  onOpenListings,
}: ProductsGalleryViewProps) {
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          selected={selectedSet.has(product.id)}
          isPausing={pausingIds.has(product.id)}
          isBulkDeleting={isBulkDeleting}
          isBulkPausing={isBulkPausing}
          onToggleSelect={onToggleSelectOne}
          onView={onView}
          onEdit={onEdit}
          onDelete={onDelete}
          onTogglePause={onTogglePause}
          onOpenLightbox={onOpenLightbox}
          onOpenListings={onOpenListings}
        />
      ))}
    </div>
  );
}
