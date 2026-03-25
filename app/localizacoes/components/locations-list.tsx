"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  MapPin,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Package,
  Eye,
  ArrowRightLeft,
  Unlink,
  X,
  Loader2,
} from "lucide-react";
import Image from "next/image";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import { getApiBaseUrl } from "@/lib/api";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface Location {
  id: string;
  userId: string;
  code: string;
  description?: string;
  maxCapacity: number;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  productsCount: number;
  childrenCount: number;
  occupancy: number;
  children?: Location[];
}

interface LocationProduct {
  id: string;
  sku: string;
  name: string;
  imageUrl?: string;
  stock: number;
  price: number;
  location?: string;
}

interface SelectLocation {
  id: string;
  code: string;
  fullPath: string;
  maxCapacity: number;
  productsCount: number;
  isFull: boolean;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

// ──────────────────────────────────────────────
// Skeleton Loader
// ──────────────────────────────────────────────

function LocationSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border p-4">
          <div className="flex items-center gap-4">
            <Skeleton className="h-10 w-10 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// Capacity Badge
// ──────────────────────────────────────────────

function CapacityBadge({ occupancy }: { occupancy: number }) {
  if (occupancy >= 90) return <Badge variant="destructive">{occupancy}%</Badge>;
  if (occupancy >= 70) return <Badge variant="warning">{occupancy}%</Badge>;
  return <Badge variant="success">{occupancy}%</Badge>;
}

// ──────────────────────────────────────────────
// Location Row (recursive for hierarchy)
// ──────────────────────────────────────────────

function LocationRow({
  location,
  depth,
  onEdit,
  onDelete,
  onAddChild,
  onViewProducts,
  onMoveLocation,
}: {
  location: Location;
  depth: number;
  onEdit: (loc: Location) => void;
  onDelete: (id: string, code: string) => void;
  onAddChild: (parentId: string, parentCode: string) => void;
  onViewProducts: (loc: Location) => void;
  onMoveLocation: (loc: Location) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = location.children && location.children.length > 0;

  return (
    <>
      <div
        className="group flex items-center gap-3 rounded-lg border border-border/60 bg-card/60 p-3 transition-colors hover:bg-muted/40"
        style={{ marginLeft: depth * 24 }}
      >
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )
          ) : (
            <MapPin className="size-4 text-muted-foreground/40" />
          )}
        </button>

        {/* Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {depth === 0 ? (
            <FolderOpen className="size-5" />
          ) : (
            <Package className="size-4" />
          )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{location.code}</span>
            {location.description && (
              <span className="truncate text-sm text-muted-foreground">
                — {location.description}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3">
            {/* Capacity bar */}
            {location.maxCapacity > 0 ? (
              <div className="flex items-center gap-2">
                <div className="w-24">
                  <Progress value={location.occupancy} className="h-1.5" />
                </div>
                <CapacityBadge occupancy={location.occupancy} />
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline hover:text-foreground transition-colors cursor-pointer"
                  onClick={() => onViewProducts(location)}
                  title="Ver produtos vinculados"
                >
                  {location.productsCount}/{location.maxCapacity}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline hover:text-foreground transition-colors cursor-pointer"
                onClick={() => onViewProducts(location)}
                title="Ver produtos vinculados"
              >
                {location.productsCount} produto(s) · Sem limite
              </button>
            )}
            {location.childrenCount > 0 && (
              <span className="text-xs text-muted-foreground">
                · {location.childrenCount} subtópico(s)
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Ver produtos"
            onClick={() => onViewProducts(location)}
          >
            <Eye className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Mover localização"
            onClick={() => onMoveLocation(location)}
          >
            <ArrowRightLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Adicionar subtópico"
            onClick={() => onAddChild(location.id, location.code)}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Editar"
            onClick={() => onEdit(location)}
          >
            <Pencil className="size-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon-sm" title="Excluir">
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir localização?</AlertDialogTitle>
                <AlertDialogDescription>
                  {`Tem certeza que deseja excluir "${location.code}"? ${
                    location.childrenCount > 0
                      ? `Todos os ${location.childrenCount} subtópico(s) também serão excluídos. `
                      : ""
                  }${
                    location.productsCount > 0
                      ? `Os ${location.productsCount} produto(s) vinculados serão desvinculados. `
                      : ""
                  }Esta ação é irreversível.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(location.id, location.code)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Excluir
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div className="space-y-2">
          {location.children!.map((child) => (
            <LocationRow
              key={child.id}
              location={child}
              depth={depth + 1}
              onEdit={onEdit}
              onDelete={onDelete}
              onAddChild={onAddChild}
              onViewProducts={onViewProducts}
              onMoveLocation={onMoveLocation}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ──────────────────────────────────────────────
// Create/Edit Location Dialog
// ──────────────────────────────────────────────

function LocationFormDialog({
  open,
  onOpenChange,
  mode,
  initialData,
  parentInfo,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit" | "create-child";
  initialData?: { code: string; description: string; maxCapacity: number };
  parentInfo?: { id: string; code: string };
  onSubmit: (data: {
    code: string;
    description: string;
    maxCapacity: number;
    parentId?: string;
  }) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [code, setCode] = useState(initialData?.code ?? "");
  const [description, setDescription] = useState(
    initialData?.description ?? "",
  );
  const [maxCapacity, setMaxCapacity] = useState(
    initialData?.maxCapacity?.toString() ?? "0",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setCode(initialData?.code ?? "");
      setDescription(initialData?.description ?? "");
      setMaxCapacity(initialData?.maxCapacity?.toString() ?? "0");
      setErrors({});
    }
  }, [open, initialData]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!code.trim()) newErrors.code = "Sigla é obrigatória";
    if (code.trim().length > 20) newErrors.code = "Máximo 20 caracteres";
    if (description.length > 200)
      newErrors.description = "Máximo 200 caracteres";
    const cap = parseInt(maxCapacity);
    if (isNaN(cap) || cap < 0)
      newErrors.maxCapacity = "Deve ser um número não negativo";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    await onSubmit({
      code: code.trim().toUpperCase(),
      description: description.trim(),
      maxCapacity: parseInt(maxCapacity) || 0,
      parentId: parentInfo?.id,
    });
  };

  const title =
    mode === "edit"
      ? "Editar Localização"
      : mode === "create-child"
        ? `Novo Subtópico em ${parentInfo?.code}`
        : "Nova Localização";

  const subtitle =
    mode === "edit"
      ? "Atualize os dados da localização."
      : mode === "create-child"
        ? `Crie uma subdivisão dentro de "${parentInfo?.code}".`
        : "Cadastre um novo local de armazenamento principal.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="loc-code">
              Sigla <span className="text-destructive">*</span>
            </Label>
            <Input
              id="loc-code"
              placeholder="Ex: G1, PRAT-A, CX-01"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={20}
              className="uppercase"
            />
            {errors.code && (
              <p className="text-sm text-destructive">{errors.code}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="loc-description">Descrição</Label>
            <Input
              id="loc-description"
              placeholder="Ex: Galpão 1 localizado em Maruíra"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
            />
            {errors.description && (
              <p className="text-sm text-destructive">{errors.description}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {description.length}/200 caracteres
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="loc-capacity">Capacidade Máxima</Label>
            <Input
              id="loc-capacity"
              type="number"
              min={0}
              placeholder="0 = sem limite"
              value={maxCapacity}
              onChange={(e) => setMaxCapacity(e.target.value)}
            />
            {errors.maxCapacity && (
              <p className="text-sm text-destructive">{errors.maxCapacity}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Número máximo de produtos. Use 0 para sem limite.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting
              ? "Salvando..."
              : mode === "edit"
                ? "Salvar Alterações"
                : "Criar Localização"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────

export function LocationsList() {
  const { data: session } = useSession();
  const [locations, setLocations] = useState<Location[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [total, setTotal] = useState(0);

  // Dialog states
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<
    "create" | "edit" | "create-child"
  >("create");
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [parentInfo, setParentInfo] = useState<{
    id: string;
    code: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Products Sheet states
  const [productsSheetOpen, setProductsSheetOpen] = useState(false);
  const [sheetLocation, setSheetLocation] = useState<Location | null>(null);
  const [sheetProducts, setSheetProducts] = useState<LocationProduct[]>([]);
  const [sheetProductsTotal, setSheetProductsTotal] = useState(0);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetSearch, setSheetSearch] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    new Set(),
  );

  // Move products dialog
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [allLocations, setAllLocations] = useState<SelectLocation[]>([]);
  const [moveTargetLocationId, setMoveTargetLocationId] =
    useState<string>("__none__");
  const [isMoving, setIsMoving] = useState(false);

  // Move location dialog
  const [moveLocationDialogOpen, setMoveLocationDialogOpen] = useState(false);
  const [movingLocation, setMovingLocation] = useState<Location | null>(null);
  const [moveLocationTargetId, setMoveLocationTargetId] =
    useState<string>("__root__");
  const [isMovingLocation, setIsMovingLocation] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const showToast = useCallback(
    (message: string, type: "success" | "error" | "warning") => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    [],
  );

  const fetchLocations = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;

    setIsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (debouncedSearch.length >= 2) {
        params.set("search", debouncedSearch);
      }

      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/locations?${params}`, {
        headers: { email },
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Erro ao buscar localizações");
      }

      setLocations(data.locations);
      setTotal(data.pagination.total);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao buscar localizações",
        "error",
      );
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch, session?.user?.email, showToast]);

  useEffect(() => {
    fetchLocations();
  }, [debouncedSearch, fetchLocations]);

  // ──── Dialog handlers ────

  const handleOpenCreate = () => {
    setDialogMode("create");
    setEditingLocation(null);
    setParentInfo(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (location: Location) => {
    setDialogMode("edit");
    setEditingLocation(location);
    setParentInfo(null);
    setDialogOpen(true);
  };

  const handleOpenCreateChild = (parentId: string, parentCode: string) => {
    setDialogMode("create-child");
    setEditingLocation(null);
    setParentInfo({ id: parentId, code: parentCode });
    setDialogOpen(true);
  };

  const handleSubmit = async (data: {
    code: string;
    description: string;
    maxCapacity: number;
    parentId?: string;
  }) => {
    const email = session?.user?.email;
    if (!email) return;

    setIsSubmitting(true);
    try {
      const apiBase = getApiBaseUrl();

      if (dialogMode === "edit" && editingLocation) {
        // Update
        const response = await fetch(
          `${apiBase}/locations/${editingLocation.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", email },
            body: JSON.stringify({
              code: data.code,
              description: data.description,
              maxCapacity: data.maxCapacity,
            }),
          },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Erro ao atualizar");
        showToast("Localização atualizada com sucesso!", "success");
      } else {
        // Create (root or child)
        const response = await fetch(`${apiBase}/locations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify(data),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Erro ao criar");
        showToast("Localização criada com sucesso!", "success");
      }

      setDialogOpen(false);
      fetchLocations();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao salvar localização",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, code: string) => {
    const email = session?.user?.email;
    if (!email) return;

    try {
      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/locations/${id}`, {
        method: "DELETE",
        headers: { email },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Erro ao excluir");
      }

      showToast(`"${code}" excluída com sucesso!`, "success");
      fetchLocations();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao excluir localização",
        "error",
      );
    }
  };

  // ──── Products Sheet handlers ────

  const fetchLocationProducts = useCallback(
    async (locationId: string, search?: string) => {
      const email = session?.user?.email;
      if (!email) return;

      setSheetLoading(true);
      try {
        const apiBase = getApiBaseUrl();
        const params = new URLSearchParams({ limit: "50" });
        if (search && search.length >= 2) params.set("search", search);

        const response = await fetch(
          `${apiBase}/locations/${locationId}/products?${params}`,
          { headers: { email } },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Erro ao buscar produtos");

        setSheetProducts(data.products);
        setSheetProductsTotal(data.pagination.total);
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Erro ao buscar produtos",
          "error",
        );
      } finally {
        setSheetLoading(false);
      }
    },
    [session?.user?.email, showToast],
  );

  const fetchAllLocations = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;

    try {
      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/locations/select`, {
        headers: { email },
      });
      const data = await response.json();
      if (response.ok) setAllLocations(data.locations);
    } catch {
      // silent
    }
  }, [session?.user?.email]);

  const handleViewProducts = (location: Location) => {
    setSheetLocation(location);
    setSheetProducts([]);
    setSheetSearch("");
    setSelectedProductIds(new Set());
    setProductsSheetOpen(true);
    fetchLocationProducts(location.id);
  };

  useEffect(() => {
    if (!productsSheetOpen || !sheetLocation) return;
    const timer = setTimeout(() => {
      fetchLocationProducts(sheetLocation.id, sheetSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [sheetSearch, productsSheetOpen, sheetLocation, fetchLocationProducts]);

  const toggleProductSelection = (productId: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedProductIds.size === sheetProducts.length) {
      setSelectedProductIds(new Set());
    } else {
      setSelectedProductIds(new Set(sheetProducts.map((p) => p.id)));
    }
  };

  const handleOpenMoveDialog = () => {
    setMoveTargetLocationId("__none__");
    fetchAllLocations();
    setMoveDialogOpen(true);
  };

  const handleMoveProducts = async () => {
    const email = session?.user?.email;
    if (!email || selectedProductIds.size === 0) return;

    setIsMoving(true);
    try {
      const apiBase = getApiBaseUrl();
      const targetId =
        moveTargetLocationId === "__none__" ? null : moveTargetLocationId;

      const response = await fetch(`${apiBase}/locations/move-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({
          productIds: Array.from(selectedProductIds),
          targetLocationId: targetId,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Erro ao mover produtos");

      showToast(result.message, "success");
      setMoveDialogOpen(false);
      setSelectedProductIds(new Set());
      // Refresh both products and locations
      if (sheetLocation) fetchLocationProducts(sheetLocation.id, sheetSearch);
      fetchLocations();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao mover produtos",
        "error",
      );
    } finally {
      setIsMoving(false);
    }
  };

  const handleUnbindProducts = async (productIds: string[]) => {
    const email = session?.user?.email;
    if (!email) return;

    try {
      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/locations/move-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({ productIds, targetLocationId: null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Erro ao desvincular");

      showToast(result.message, "success");
      setSelectedProductIds(new Set());
      if (sheetLocation) fetchLocationProducts(sheetLocation.id, sheetSearch);
      fetchLocations();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao desvincular produtos",
        "error",
      );
    }
  };

  // ──── Move Location handlers ────

  const handleOpenMoveLocation = (location: Location) => {
    setMovingLocation(location);
    setMoveLocationTargetId(location.parentId || "__root__");
    fetchAllLocations();
    setMoveLocationDialogOpen(true);
  };

  const handleMoveLocation = async () => {
    const email = session?.user?.email;
    if (!email || !movingLocation) return;

    setIsMovingLocation(true);
    try {
      const apiBase = getApiBaseUrl();
      const newParentId =
        moveLocationTargetId === "__root__" ? null : moveLocationTargetId;

      const response = await fetch(
        `${apiBase}/locations/${movingLocation.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify({ parentId: newParentId }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Erro ao mover localização");

      showToast(`"${movingLocation.code}" movida com sucesso!`, "success");
      setMoveLocationDialogOpen(false);
      fetchLocations();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao mover localização",
        "error",
      );
    } finally {
      setIsMovingLocation(false);
    }
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
                : toast.type === "warning"
                  ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/80 dark:text-yellow-200"
                  : "bg-destructive text-white"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Localizações</CardTitle>
              <CardDescription>
                Organize seus produtos em locais de armazenamento
              </CardDescription>
            </div>
            <Button onClick={handleOpenCreate}>
              <Plus className="mr-2 size-4" />
              Nova Localização
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LocationSkeleton />
          ) : (
            <div className="space-y-4">
              {/* Search */}
              <div className="flex items-center gap-4">
                <div className="relative max-w-sm flex-1">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Buscar por sigla ou descrição..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="h-10 rounded-full border border-border/70 bg-muted/20 pl-9"
                  />
                </div>
                <span className="text-sm text-muted-foreground">
                  {total} localização(ões)
                </span>
              </div>

              {/* Location list */}
              {locations.length > 0 ? (
                <div className="space-y-2">
                  {locations.map((location) => (
                    <LocationRow
                      key={location.id}
                      location={location}
                      depth={0}
                      onEdit={handleOpenEdit}
                      onDelete={handleDelete}
                      onAddChild={handleOpenCreateChild}
                      onViewProducts={handleViewProducts}
                      onMoveLocation={handleOpenMoveLocation}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
                  <MapPin className="mb-3 size-10 text-muted-foreground/30" />
                  <p className="text-sm font-medium text-muted-foreground">
                    {debouncedSearch
                      ? "Nenhuma localização encontrada"
                      : "Nenhuma localização cadastrada"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    {debouncedSearch
                      ? "Tente buscar por outro termo"
                      : "Crie seu primeiro local de armazenamento"}
                  </p>
                  {!debouncedSearch && (
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={handleOpenCreate}
                    >
                      <Plus className="mr-2 size-4" />
                      Criar Localização
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <LocationFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        initialData={
          editingLocation
            ? {
                code: editingLocation.code,
                description: editingLocation.description ?? "",
                maxCapacity: editingLocation.maxCapacity,
              }
            : undefined
        }
        parentInfo={parentInfo ?? undefined}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
      />

      {/* ──── Products Sheet ──── */}
      <Sheet open={productsSheetOpen} onOpenChange={setProductsSheetOpen}>
        <SheetContent className="w-full sm:max-w-lg flex flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Package className="size-5" />
              Produtos em &quot;{sheetLocation?.code}&quot;
            </SheetTitle>
            <SheetDescription>
              {sheetProductsTotal} produto(s) vinculado(s) a esta localização
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-hidden flex flex-col gap-3 mt-4">
            {/* Search + actions bar */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar produto..."
                  value={sheetSearch}
                  onChange={(e) => setSheetSearch(e.target.value)}
                  className="h-9 pl-9"
                />
              </div>
            </div>

            {/* Bulk actions */}
            {selectedProductIds.size > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2">
                <span className="text-sm font-medium">
                  {selectedProductIds.size} selecionado(s)
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleOpenMoveDialog}
                  >
                    <ArrowRightLeft className="mr-1.5 size-3.5" />
                    Mover
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={() =>
                      handleUnbindProducts(Array.from(selectedProductIds))
                    }
                  >
                    <Unlink className="mr-1.5 size-3.5" />
                    Desvincular
                  </Button>
                </div>
              </div>
            )}

            {/* Product list */}
            <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
              {sheetLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : sheetProducts.length > 0 ? (
                <>
                  {/* Select all */}
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <Checkbox
                      checked={
                        sheetProducts.length > 0 &&
                        selectedProductIds.size === sheetProducts.length
                      }
                      onCheckedChange={toggleSelectAll}
                    />
                    <span className="text-xs text-muted-foreground">
                      Selecionar todos
                    </span>
                  </div>
                  <Separator />
                  {sheetProducts.map((product) => (
                    <div
                      key={product.id}
                      className="group flex items-center gap-3 rounded-md border border-transparent p-2 hover:border-border/60 hover:bg-muted/30"
                    >
                      <Checkbox
                        checked={selectedProductIds.has(product.id)}
                        onCheckedChange={() =>
                          toggleProductSelection(product.id)
                        }
                      />
                      {product.imageUrl ? (
                        <Image
                          src={product.imageUrl}
                          alt={product.name}
                          width={40}
                          height={40}
                          className="rounded-md border object-cover"
                        />
                      ) : (
                        <div className="flex size-10 items-center justify-center rounded-md border bg-muted">
                          <Package className="size-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {product.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {product.sku} · {product.stock} un ·{" "}
                          {new Intl.NumberFormat("pt-BR", {
                            style: "currency",
                            currency: "BRL",
                          }).format(product.price)}
                        </p>
                      </div>
                      {/* Individual actions */}
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Desvincular produto"
                          onClick={() => handleUnbindProducts([product.id])}
                        >
                          <Unlink className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <Package className="mb-3 size-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    {sheetSearch
                      ? "Nenhum produto encontrado"
                      : "Nenhum produto vinculado"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* ──── Move Products Dialog ──── */}
      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mover Produtos</DialogTitle>
            <DialogDescription>
              Mova {selectedProductIds.size} produto(s) para outra localização.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Localização de destino</Label>
              <Select
                value={moveTargetLocationId}
                onValueChange={setMoveTargetLocationId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione uma localização" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    Sem localização (desvincular)
                  </SelectItem>
                  {allLocations
                    .filter((loc) => loc.id !== sheetLocation?.id)
                    .map((loc) => (
                      <SelectItem
                        key={loc.id}
                        value={loc.id}
                        disabled={loc.isFull}
                      >
                        {loc.fullPath}
                        {loc.maxCapacity > 0
                          ? ` (${loc.productsCount}/${loc.maxCapacity})`
                          : ""}
                        {loc.isFull ? " — Lotado" : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMoveDialogOpen(false)}
              disabled={isMoving}
            >
              Cancelar
            </Button>
            <Button onClick={handleMoveProducts} disabled={isMoving}>
              {isMoving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Movendo...
                </>
              ) : (
                "Mover Produtos"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ──── Move Location Dialog ──── */}
      <Dialog
        open={moveLocationDialogOpen}
        onOpenChange={setMoveLocationDialogOpen}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mover Localização</DialogTitle>
            <DialogDescription>
              Altere a posição de &quot;{movingLocation?.code}&quot; na
              hierarquia.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Novo local pai</Label>
              <Select
                value={moveLocationTargetId}
                onValueChange={setMoveLocationTargetId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o destino" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__root__">
                    Raiz (sem localização pai)
                  </SelectItem>
                  {allLocations
                    .filter((loc) => loc.id !== movingLocation?.id)
                    .map((loc) => (
                      <SelectItem key={loc.id} value={loc.id}>
                        {loc.fullPath}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Selecione onde esta localização ficará na hierarquia.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMoveLocationDialogOpen(false)}
              disabled={isMovingLocation}
            >
              Cancelar
            </Button>
            <Button onClick={handleMoveLocation} disabled={isMovingLocation}>
              {isMovingLocation ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Movendo...
                </>
              ) : (
                "Mover Localização"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
