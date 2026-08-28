"use client";

import { Eye, Package, Pencil, Trash2 } from "lucide-react";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { MarketplacePlatform, Product } from "../lib/product-view-types";
import {
  formatDate,
  formatPrice,
  getStockBadgeVariant,
  getStockDisplay,
} from "../lib/product-format";
import {
  computeProductPauseState,
  MarketplaceBadges,
  PauseListingsButton,
} from "../lib/product-listing-badges";

interface ProductsListViewProps {
  products: Product[];
  selectedIds: string[];
  pausingIds: Set<string>;
  allSelected: boolean;
  isIndeterminate: boolean;
  isBulkDeleting: boolean;
  isBulkPausing: boolean;
  onToggleSelectAll: (checked: boolean | "indeterminate") => void;
  onToggleSelectOne: (id: string, checked: boolean | "indeterminate") => void;
  onView: (product: Product) => void;
  onEdit: (product: Product) => void;
  onDelete: (id: string) => void;
  onTogglePause: (product: Product, status: "active" | "paused") => void;
  onOpenLightbox: (product: Product) => void;
  onOpenListings: (product: Product, platform: MarketplacePlatform) => void;
}

/**
 * Visão "Lista" de Produtos — tabela (desktop) + cards (mobile) extraídos 1:1 de
 * `products-list.tsx` SEM mudança de colunas/lógica/JSX. A fonte da verdade da
 * seleção e dos handlers continua no container; aqui tudo chega por props.
 */
export function ProductsListView({
  products,
  selectedIds,
  pausingIds,
  allSelected,
  isIndeterminate,
  isBulkDeleting,
  isBulkPausing,
  onToggleSelectAll: toggleSelectAll,
  onToggleSelectOne: toggleSelectOne,
  onView: setViewProduct,
  onEdit: handleEditClick,
  onDelete: handleDelete,
  onTogglePause: handleTogglePause,
  onOpenLightbox: openProductLightbox,
  onOpenListings,
}: ProductsListViewProps) {
  return (
    <>
      <div className="hidden rounded-md border sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  aria-label="Selecionar todos os produtos desta página"
                  checked={
                    allSelected
                      ? true
                      : isIndeterminate
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={toggleSelectAll}
                  disabled={isBulkDeleting || isBulkPausing}
                />
              </TableHead>
              <TableHead>Imagem</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead className="hidden md:table-cell">
                Marketplaces
              </TableHead>
              <TableHead className="hidden md:table-cell">Preço</TableHead>
              <TableHead>Estoque</TableHead>
              <TableHead className="hidden lg:table-cell">
                Localização
              </TableHead>
              <TableHead className="hidden lg:table-cell">Criado em</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product) => (
              <TableRow
                key={product.id}
                data-state={
                  selectedIds.includes(product.id) ? "selected" : undefined
                }
                className="cursor-pointer"
              >
                <TableCell>
                  <Checkbox
                    aria-label={`Selecionar ${product.name}`}
                    checked={selectedIds.includes(product.id)}
                    onCheckedChange={(checked) =>
                      toggleSelectOne(product.id, checked)
                    }
                    disabled={isBulkDeleting || isBulkPausing}
                  />
                </TableCell>
                <TableCell>
                  {product.imageUrl ? (
                    <button
                      type="button"
                      onClick={() => openProductLightbox(product)}
                      title="Ampliar imagem"
                      className="group relative h-24 w-24 overflow-hidden rounded border bg-transparent transition-shadow hover:shadow-md"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        loading="lazy"
                        decoding="async"
                        className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    </button>
                  ) : (
                    <div className="flex h-24 w-24 items-center justify-center rounded border bg-muted">
                      <Package className="h-12 w-12 text-muted-foreground" />
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {product.sku}
                </TableCell>
                <TableCell className="font-medium">
                  <div>
                    <p>{product.name}</p>
                    {product.createdFromMarketplace &&
                      product.originPlatform && (
                        <Badge
                          variant="secondary"
                          className="mt-0.5 font-normal"
                        >
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
                        </Badge>
                      )}
                    {product.description && (
                      <p
                        className="text-xs text-muted-foreground"
                        title={product.description}
                      >
                        {product.description.length > 80
                          ? `${product.description.slice(0, 80)}...`
                          : product.description}
                      </p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <MarketplaceBadges
                    listings={product.listings}
                    onOpenListings={(platform) =>
                      onOpenListings(product, platform)
                    }
                  />
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {formatPrice(product.price)}
                </TableCell>
                <TableCell>
                  {(() => {
                    // BLOCO G — disponível quando há venda pendente segurando a
                    // peça; sem reserva, idêntico ao de antes.
                    const e = getStockDisplay(
                      product.stock,
                      product.reservedStock,
                    );
                    return (
                      <>
                        <Badge
                          variant={getStockBadgeVariant(e.value)}
                          title={e.detail ?? undefined}
                        >
                          {e.value} {e.suffix}
                        </Badge>
                        {e.detail ? (
                          <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
                            {e.detail}
                          </p>
                        ) : null}
                      </>
                    );
                  })()}
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {product.locationPath ??
                    product.productLocation?.code ??
                    product.location ??
                    "—"}
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {formatDate(product.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Ver detalhes"
                      onClick={() => setViewProduct(product)}
                    >
                      <Eye className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Editar"
                      onClick={() => handleEditClick(product)}
                    >
                      <Pencil className="size-4" />
                    </Button>

                    <PauseListingsButton
                      product={product}
                      state={computeProductPauseState(product.listings)}
                      isPausing={pausingIds.has(product.id)}
                      onTogglePause={handleTogglePause}
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
                            onClick={() => handleDelete(product.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Excluir
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 sm:hidden">
        {products.map((product) => (
          <div
            key={product.id}
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <div className="flex items-start gap-3">
              <Checkbox
                aria-label={`Selecionar ${product.name}`}
                className="mt-1"
                checked={selectedIds.includes(product.id)}
                onCheckedChange={(checked) =>
                  toggleSelectOne(product.id, checked)
                }
                disabled={isBulkDeleting || isBulkPausing}
              />
              {product.imageUrl ? (
                <button
                  type="button"
                  onClick={() => openProductLightbox(product)}
                  title="Ampliar imagem"
                  className="group relative h-32 w-32 flex-shrink-0 overflow-hidden rounded border bg-transparent transition-shadow hover:shadow-md"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={product.imageUrl}
                    alt={product.name}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                </button>
              ) : (
                <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded border bg-muted">
                  <Package className="h-16 w-16 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate font-medium">{product.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {product.sku}
                    </p>
                    {product.createdFromMarketplace &&
                      product.originPlatform && (
                        <Badge variant="secondary" className="font-normal">
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
                        </Badge>
                      )}
                    <MarketplaceBadges
                      listings={product.listings}
                      size="sm"
                      onOpenListings={(platform) =>
                        onOpenListings(product, platform)
                      }
                    />
                    {(product.locationPath ||
                      product.location ||
                      product.productLocation?.code) && (
                      <p className="text-xs text-muted-foreground">
                        {product.locationPath ??
                          product.productLocation?.code ??
                          product.location}
                      </p>
                    )}
                  </div>
                  {(() => {
                    // BLOCO G — mesma regra da visão de tabela.
                    const e = getStockDisplay(
                      product.stock,
                      product.reservedStock,
                    );
                    return (
                      <div className="text-right">
                        <Badge
                          variant={getStockBadgeVariant(e.value)}
                          title={e.detail ?? undefined}
                        >
                          {e.value} {e.suffix}
                        </Badge>
                        {e.detail ? (
                          <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
                            {e.detail}
                          </p>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
                {product.description && (
                  <p
                    className="mt-2 text-sm text-muted-foreground"
                    title={product.description}
                  >
                    {product.description.length > 120
                      ? `${product.description.slice(0, 120)}...`
                      : product.description}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between border-t pt-2">
              <span className="font-mono text-lg font-semibold tabular-nums">
                {formatPrice(product.price)}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Ver detalhes"
                  onClick={() => setViewProduct(product)}
                >
                  <Eye className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleEditClick(product)}
                >
                  <Pencil className="size-4" />
                </Button>

                <PauseListingsButton
                  product={product}
                  state={computeProductPauseState(product.listings)}
                  isPausing={pausingIds.has(product.id)}
                  onTogglePause={handleTogglePause}
                />

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon-sm">
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
                        onClick={() => handleDelete(product.id)}
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
        ))}
      </div>
    </>
  );
}
