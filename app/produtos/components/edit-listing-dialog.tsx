"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  Loader2,
  PauseCircle,
  PlayCircle,
  Save,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  LISTING_PLATFORM_LABELS,
  getListingStatusBadge,
} from "@/app/produtos/lib/listing-status-labels";
import type { MarketplaceListingPlatform } from "@/app/lib/marketplace-listing-links";
import { getApiBaseUrl } from "@/lib/api";

type ListingDetail = {
  id: string;
  externalListingId: string | null;
  externalSku: string | null;
  permalink: string | null;
  status: string;
  listingType: string | null;
  itemCondition: string | null;
  hasWarranty: boolean | null;
  warrantyUnit: string | null;
  warrantyDuration: number | null;
  shippingMode: string | null;
  freeShipping: boolean | null;
  localPickup: boolean | null;
  manufacturingTime: number | null;
  updatedAt: string;
  product: { id: string; name: string; sku: string };
  account: {
    id: string;
    accountName: string;
    platform: MarketplaceListingPlatform;
  };
};

interface EditListingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listingId: string | null;
  onSaved?: () => void;
  onToast?: (message: string, type: "success" | "error" | "warning") => void;
}

type FormState = {
  listingType: string;
  itemCondition: string;
  hasWarranty: boolean;
  warrantyUnit: string;
  warrantyDuration: number;
  shippingMode: string;
  freeShipping: boolean;
  localPickup: boolean;
  manufacturingTime: number;
};

const DEFAULT_FORM: FormState = {
  listingType: "bronze",
  itemCondition: "new",
  hasWarranty: false,
  warrantyUnit: "dias",
  warrantyDuration: 30,
  shippingMode: "me2",
  freeShipping: false,
  localPickup: false,
  manufacturingTime: 0,
};

function buildFormState(listing: ListingDetail): FormState {
  return {
    listingType: listing.listingType ?? DEFAULT_FORM.listingType,
    itemCondition: listing.itemCondition ?? DEFAULT_FORM.itemCondition,
    hasWarranty: listing.hasWarranty ?? DEFAULT_FORM.hasWarranty,
    warrantyUnit: listing.warrantyUnit ?? DEFAULT_FORM.warrantyUnit,
    warrantyDuration:
      listing.warrantyDuration ?? DEFAULT_FORM.warrantyDuration,
    shippingMode: listing.shippingMode ?? DEFAULT_FORM.shippingMode,
    freeShipping: listing.freeShipping ?? DEFAULT_FORM.freeShipping,
    localPickup: listing.localPickup ?? DEFAULT_FORM.localPickup,
    manufacturingTime:
      listing.manufacturingTime ?? DEFAULT_FORM.manufacturingTime,
  };
}

export function EditListingDialog({
  open,
  onOpenChange,
  listingId,
  onSaved,
  onToast,
}: EditListingDialogProps) {
  const { data: session } = useSession();
  const email = session?.user?.email ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);

  const platformLabel = listing
    ? LISTING_PLATFORM_LABELS[listing.account.platform]
    : "";

  const isML = listing?.account.platform === "MERCADO_LIVRE";
  const isShopee = listing?.account.platform === "SHOPEE";

  const isPaused = useMemo(() => {
    const s = (listing?.status ?? "").toLowerCase();
    return s === "paused" || s === "unlist";
  }, [listing?.status]);

  useEffect(() => {
    if (!open || !listingId || !email) return;

    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `${getApiBaseUrl()}/listings/${encodeURIComponent(listingId)}`,
          { headers: { email }, signal: controller.signal },
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(
            data.message || data.error || `HTTP ${response.status}`,
          );
        }
        const data = (await response.json()) as { listing: ListingDetail };
        if (cancelled) return;
        setListing(data.listing);
        setForm(buildFormState(data.listing));
      } catch (err) {
        if (cancelled || (err as Error).name === "AbortError") return;
        setError(
          err instanceof Error
            ? err.message
            : "Não foi possível carregar o anúncio",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, listingId, email]);

  useEffect(() => {
    if (!open) {
      setListing(null);
      setForm(DEFAULT_FORM);
      setError(null);
      setLoading(false);
      setSaving(false);
      setStatusUpdating(false);
    }
  }, [open]);

  const handleSave = async () => {
    if (!listingId || !email) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/listings/${encodeURIComponent(listingId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify({
            listingType: form.listingType,
            itemCondition: form.itemCondition,
            hasWarranty: form.hasWarranty,
            warrantyUnit: form.warrantyUnit,
            warrantyDuration: form.warrantyDuration,
            shippingMode: form.shippingMode,
            freeShipping: form.freeShipping,
            localPickup: form.localPickup,
            manufacturingTime: form.manufacturingTime,
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }
      onToast?.("Anúncio atualizado com sucesso", "success");
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Erro ao atualizar anúncio";
      setError(msg);
      onToast?.(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async () => {
    if (!listingId || !email || !listing) return;
    const nextStatus: "active" | "paused" = isPaused ? "active" : "paused";
    setStatusUpdating(true);
    setError(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/listings/${encodeURIComponent(listingId)}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }
      setListing((prev) => (prev ? { ...prev, status: nextStatus } : prev));
      onToast?.(
        nextStatus === "paused"
          ? "Anúncio pausado"
          : "Anúncio reativado",
        "success",
      );
      onSaved?.();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Erro ao alterar status";
      setError(msg);
      onToast?.(msg, "error");
    } finally {
      setStatusUpdating(false);
    }
  };

  const statusBadge = listing ? getListingStatusBadge(listing.status) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {platformLabel
              ? `Editar anúncio · ${platformLabel}`
              : "Editar anúncio"}
          </DialogTitle>
          {listing && (
            <DialogDescription>
              {listing.account.accountName} · {listing.product.sku} ·{" "}
              {listing.product.name}
            </DialogDescription>
          )}
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 rounded-lg border bg-muted/40 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Carregando anúncio…
          </div>
        )}

        {!loading && error && !listing && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4" />
            <div>{error}</div>
          </div>
        )}

        {!loading && listing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {listing.externalListingId ?? "Sem ID externo"}
                </span>
                {statusBadge && (
                  <Badge variant={statusBadge.variant}>
                    {statusBadge.label}
                  </Badge>
                )}
              </div>

              {isML && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleToggleStatus}
                  disabled={statusUpdating}
                >
                  {statusUpdating ? (
                    <Loader2 className="mr-1.5 size-3 animate-spin" />
                  ) : isPaused ? (
                    <PlayCircle className="mr-1.5 size-3" />
                  ) : (
                    <PauseCircle className="mr-1.5 size-3" />
                  )}
                  {isPaused ? "Reativar anúncio" : "Pausar anúncio"}
                </Button>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4" />
                <div>{error}</div>
              </div>
            )}

            {isShopee && (
              <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                Edição detalhada de campos da Shopee ainda não está
                disponível por aqui. Para alterar nome, descrição, preço,
                dimensões ou estoque deste anúncio, use{" "}
                <strong>Editar produto</strong> — as mudanças serão
                propagadas para o anúncio pelo fluxo de sincronização.
              </div>
            )}

            {isML && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Tipo de anúncio</Label>
                  <Select
                    value={form.listingType}
                    onValueChange={(v) =>
                      setForm((prev) => ({ ...prev, listingType: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gold_premium">Premium</SelectItem>
                      <SelectItem value="gold_special">Clássico</SelectItem>
                      <SelectItem value="bronze">Grátis</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Condição</Label>
                  <Select
                    value={form.itemCondition}
                    onValueChange={(v) =>
                      setForm((prev) => ({ ...prev, itemCondition: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">Novo</SelectItem>
                      <SelectItem value="used">Usado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <Label htmlFor="has-warranty">Oferece garantia</Label>
                    <Switch
                      id="has-warranty"
                      checked={form.hasWarranty}
                      onCheckedChange={(checked) =>
                        setForm((prev) => ({ ...prev, hasWarranty: checked }))
                      }
                    />
                  </div>
                </div>

                {form.hasWarranty && (
                  <>
                    <div className="space-y-2">
                      <Label>Duração da garantia</Label>
                      <Input
                        type="number"
                        min={1}
                        value={form.warrantyDuration}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            warrantyDuration: Math.max(
                              1,
                              Number(e.target.value) || 1,
                            ),
                          }))
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Unidade</Label>
                      <Select
                        value={form.warrantyUnit}
                        onValueChange={(v) =>
                          setForm((prev) => ({ ...prev, warrantyUnit: v }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="dias">Dias</SelectItem>
                          <SelectItem value="meses">Meses</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <Label>Modo de envio</Label>
                  <Select
                    value={form.shippingMode}
                    onValueChange={(v) =>
                      setForm((prev) => ({ ...prev, shippingMode: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="me2">Mercado Envios (ME2)</SelectItem>
                      <SelectItem value="me1">Mercado Envios 1</SelectItem>
                      <SelectItem value="custom">Frete personalizado</SelectItem>
                      <SelectItem value="not_specified">
                        Não especificar
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Tempo de envio (dias)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.manufacturingTime}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        manufacturingTime: Math.max(
                          0,
                          Number(e.target.value) || 0,
                        ),
                      }))
                    }
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-3">
                  <Label htmlFor="free-shipping">Frete grátis</Label>
                  <Switch
                    id="free-shipping"
                    checked={form.freeShipping}
                    onCheckedChange={(checked) =>
                      setForm((prev) => ({ ...prev, freeShipping: checked }))
                    }
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-3">
                  <Label htmlFor="local-pickup">Retirada local</Label>
                  <Switch
                    id="local-pickup"
                    checked={form.localPickup}
                    onCheckedChange={(checked) =>
                      setForm((prev) => ({ ...prev, localPickup: checked }))
                    }
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          {isML && (
            <Button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || !listing}
            >
              {saving ? (
                <Loader2 className="mr-1.5 size-3 animate-spin" />
              ) : (
                <Save className="mr-1.5 size-3" />
              )}
              Salvar alterações
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
