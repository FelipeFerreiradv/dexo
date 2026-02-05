"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Pencil,
  Trash2,
  Package,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// NextAuth
import { useSession } from "next-auth/react";
import { ProductSkeleton } from "./product-skeleton";
import { CreateProductDialog } from "./create-product-dialog";
import { EditProductDialog } from "./edit-product-dialog";

type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";

interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  price: number;
  stock: number;
  createdAt: string;
  updatedAt: string;
  // Campos de autopeças
  costPrice?: number | null;
  markup?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  category?: string | null;
  location?: string | null;
  partNumber?: string | null;
  quality?: Quality | null;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string | null;
  imageUrl?: string | null;
}

interface ProductFormData {
  name: string;
  description: string;
  price: number;
  stock: number;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface Toast {
  id: number;
  message: string;
  type: "success" | "error";
}

export function ProductsList() {
  const { data: session } = useSession();
  const [products, setProducts] = useState<Product[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      const id = Date.now();
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    [],
  );

  const fetchProducts = useCallback(
    async (page: number = 1, searchTerm: string = "") => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams({
          page: page.toString(),
          limit: "10",
        });
        if (searchTerm) {
          params.set("search", searchTerm);
        }

        const response = await fetch(
          `http://localhost:3333/products?${params}`,
        );
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Erro ao buscar produtos");
        }

        setProducts(data.products);
        setPagination(data.pagination);
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Erro ao buscar produtos",
          "error",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    fetchProducts(1, search);
  }, [fetchProducts, search]);

  const handleSearch = (value: string) => {
    setSearch(value);
  };

  const handlePageChange = (newPage: number) => {
    fetchProducts(newPage, search);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Tem certeza que deseja excluir o produto "${name}"?`)) {
      return;
    }

    try {
      const response = await fetch(`http://localhost:3333/products/${id}`, {
        method: "DELETE",
        headers: {
          email: session?.user?.email || "",
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Erro ao excluir produto");
      }

      showToast("Produto excluído com sucesso!", "success");
      fetchProducts(pagination.page, search);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao excluir produto",
        "error",
      );
    }
  };

  const handleEditClick = (product: Product) => {
    setEditingProduct(product);
    setIsEditDialogOpen(true);
  };

  const handleEdit = async (id: string, productData: ProductFormData) => {
    try {
      const response = await fetch(`http://localhost:3333/products/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(productData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Erro ao atualizar produto");
      }

      showToast("Produto atualizado com sucesso!", "success");
      fetchProducts(pagination.page, search);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao atualizar produto",
        "error",
      );
    }
  };

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(price);
  };

  const formatDate = (dateString: string) => {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(dateString));
  };

  const getStockBadgeVariant = (stock: number) => {
    if (stock === 0) return "destructive";
    if (stock <= 10) return "warning";
    return "success";
  };

  return (
    <div className="space-y-6">
      {/* Toast notifications */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-lg px-4 py-3 text-sm font-medium shadow-lg animate-in slide-in-from-right-full ${
              toast.type === "success"
                ? "bg-green-100 text-green-800 dark:bg-green-900/80 dark:text-green-200"
                : "bg-destructive text-white"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Produtos</CardTitle>
              <CardDescription>
                Gerencie o catálogo de produtos do seu estoque central
              </CardDescription>
            </div>
            <CreateProductDialog
              onProductCreated={() => fetchProducts(1, search)}
              onToast={showToast}
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <ProductSkeleton />
          ) : (
            <div className="space-y-4">
              {/* Search */}
              <div className="flex items-center gap-4">
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Buscar por nome ou SKU..."
                    value={search}
                    onChange={(e) => handleSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <span className="text-sm text-muted-foreground">
                  {pagination.total} produto(s)
                </span>
              </div>

              {/* Desktop Table */}
              {products.length > 0 ? (
                <>
                  <div className="hidden sm:block rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Imagem</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead>Nome</TableHead>
                          <TableHead className="hidden md:table-cell">
                            Preço
                          </TableHead>
                          <TableHead>Estoque</TableHead>
                          <TableHead className="hidden lg:table-cell">
                            Criado em
                          </TableHead>
                          <TableHead className="text-right">Ações</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {products.map((product) => (
                          <TableRow key={product.id} className="cursor-pointer">
                            <TableCell>
                              {product.imageUrl ? (
                                <img
                                  src={product.imageUrl}
                                  alt={product.name}
                                  className="w-12 h-12 object-cover rounded border"
                                  onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                  }}
                                />
                              ) : (
                                <div className="w-12 h-12 bg-muted rounded border flex items-center justify-center">
                                  <Package className="w-6 h-6 text-muted-foreground" />
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {product.sku}
                            </TableCell>
                            <TableCell className="font-medium">
                              <div>
                                <p>{product.name}</p>
                                {product.description && (
                                  <p className="text-xs text-muted-foreground line-clamp-1">
                                    {product.description}
                                  </p>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              {formatPrice(product.price)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={getStockBadgeVariant(product.stock)}
                              >
                                {product.stock} un.
                              </Badge>
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-muted-foreground">
                              {formatDate(product.createdAt)}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title="Editar"
                                  onClick={() => handleEditClick(product)}
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title="Excluir"
                                  onClick={() =>
                                    handleDelete(product.id, product.name)
                                  }
                                >
                                  <Trash2 className="size-4 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile Cards */}
                  <div className="sm:hidden space-y-3">
                    {products.map((product) => (
                      <div
                        key={product.id}
                        className="rounded-lg border bg-card p-4 space-y-3"
                      >
                        <div className="flex items-start gap-3">
                          {product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt={product.name}
                              className="w-16 h-16 object-cover rounded border flex-shrink-0"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : (
                            <div className="w-16 h-16 bg-muted rounded border flex items-center justify-center flex-shrink-0">
                              <Package className="w-8 h-8 text-muted-foreground" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="space-y-1 min-w-0 flex-1">
                                <p className="font-medium truncate">
                                  {product.name}
                                </p>
                                <p className="font-mono text-xs text-muted-foreground">
                                  {product.sku}
                                </p>
                              </div>
                              <Badge
                                variant={getStockBadgeVariant(product.stock)}
                              >
                                {product.stock} un.
                              </Badge>
                            </div>
                            {product.description && (
                              <p className="text-sm text-muted-foreground line-clamp-2 mt-2">
                                {product.description}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center justify-between pt-2 border-t">
                          <span className="text-lg font-semibold">
                            {formatPrice(product.price)}
                          </span>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleEditClick(product)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() =>
                                handleDelete(product.id, product.name)
                              }
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Pagination */}
                  {pagination.totalPages > 1 && (
                    <div className="flex items-center justify-between pt-4">
                      <p className="text-sm text-muted-foreground">
                        Página {pagination.page} de {pagination.totalPages}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pagination.page === 1}
                          onClick={() => handlePageChange(pagination.page - 1)}
                        >
                          <ChevronLeft className="size-4" />
                          Anterior
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pagination.page === pagination.totalPages}
                          onClick={() => handlePageChange(pagination.page + 1)}
                        >
                          Próxima
                          <ChevronRight className="size-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                /* Empty State */
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="flex size-16 items-center justify-center rounded-full bg-muted">
                    <Package className="size-8 text-muted-foreground" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold">
                    Nenhum produto cadastrado
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground max-w-sm">
                    {search
                      ? `Nenhum produto encontrado para "${search}". Tente outro termo de busca.`
                      : "Comece adicionando seu primeiro produto ao catálogo."}
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {editingProduct && (
        <EditProductDialog
          product={editingProduct}
          open={isEditDialogOpen}
          onOpenChange={(open) => {
            setIsEditDialogOpen(open);
            if (!open) {
              // Limpar o produto em edição quando fechar o modal
              // para garantir que ao reabrir, pegue dados atualizados da lista
              setEditingProduct(null);
            }
          }}
          onProductUpdated={() => fetchProducts(pagination.page, search)}
          onToast={showToast}
        />
      )}
    </div>
  );
}
