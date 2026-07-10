"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Package,
  User,
  Calendar,
  DollarSign,
  Clock,
  Store,
  FileText,
  Loader2,
  MapPin,
  Printer,
  ExternalLink,
} from "lucide-react";
import Image from "next/image";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Order, OrderStatus } from "@/app/interfaces/order.interface";
import { getApiBaseUrl } from "@/lib/api";
import {
  resolveMarketplaceListingLinkState,
  type MarketplaceListingPlatform,
} from "@/app/lib/marketplace-listing-links";

const isFiscalEnabled =
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED === "true";

const isEtiquetasEnabled =
  process.env.NEXT_PUBLIC_ETIQUETAS_MODULE_ENABLED === "true";

interface OrderDetailSheetProps {
  order: Order | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOrderUpdate: () => void;
}

const statusStyles: Record<OrderStatus, string> = {
  PENDING:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-200",
  PAID: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  SHIPPED:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/40 dark:text-sky-200",
  DELIVERED: "border-primary/60 bg-primary/10 text-primary",
  CANCELLED: "border-destructive/60 bg-destructive/10 text-destructive",
};

const formatCurrency = (value: number) =>
  value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

const formatDateTime = (value: Date | string) =>
  new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });

/**
 * Miniatura do item no detalhe: foto via next/image (otimizador global
 * desligado) com fallback neutro (`Package`) quando não há imagem ou ela falha.
 */
function ItemThumb({ src, alt }: { src: string | null; alt: string }) {
  const [error, setError] = useState(false);
  const showImage = Boolean(src) && !error;
  return (
    <div className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-muted sm:size-24">
      {showImage ? (
        <Image
          src={src as string}
          alt={alt}
          fill
          sizes="96px"
          className="object-cover"
          onError={() => setError(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Package className="size-6 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

export function OrderDetailSheet({
  order,
  open,
  onOpenChange,
  onOrderUpdate,
}: OrderDetailSheetProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [isCreatingNfe, setIsCreatingNfe] = useState(false);
  const [nfeError, setNfeError] = useState<string | null>(null);
  const [labelLoading, setLabelLoading] = useState(false);
  const [labelSize, setLabelSize] = useState<"A4" | "THERMAL">("A4");
  const [labelMsg, setLabelMsg] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const { data: session } = useSession();
  const router = useRouter();

  // Warm up the NF-e wizard bundle while the user is still reading the sheet —
  // clicking "Emitir NF-e" then lands on a pre-hydrated page.
  useEffect(() => {
    if (open && isFiscalEnabled) {
      router.prefetch("/notas-fiscais/nfe");
    }
  }, [open, router]);

  // Limpa o estado da etiqueta ao trocar de pedido.
  useEffect(() => {
    setLabelMsg(null);
    setLabelError(null);
  }, [order?.id]);

  const handleEmitirNfe = async () => {
    if (!order || !session?.user?.email || isCreatingNfe) return;

    setIsCreatingNfe(true);
    setNfeError(null);
    try {
      const apiBase = getApiBaseUrl();
      const headers = {
        "Content-Type": "application/json",
        email: session.user.email,
      };

      const createRes = await fetch(`${apiBase}/fiscal/nfe/draft`, {
        method: "POST",
        headers,
        body: JSON.stringify({ orderId: order.id }),
      });

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        setNfeError(
          err?.error ||
            "Não foi possível criar o rascunho. Verifique a configuração fiscal.",
        );
        return;
      }

      const { draft } = await createRes.json();
      const draftId = draft?.id as string | undefined;
      if (!draftId) {
        setNfeError("Rascunho criado sem ID. Tente novamente.");
        return;
      }

      // O servidor já devolve o rascunho POPULADO (destinatário + itens +
      // valores do pedido) no POST acima — não há PUT de prefill aqui: evita um
      // round-trip extra e não sobrescreve os dados ricos vindos do servidor.
      router.push(`/notas-fiscais/nfe?draft=${draftId}`);
    } catch {
      setNfeError("Erro de conexão ao iniciar emissão de NF-e.");
    } finally {
      setIsCreatingNfe(false);
    }
  };

  // Abre o PDF da etiqueta já gerada numa nova aba (busca com auth → blob).
  const openLabelPdf = async (): Promise<boolean> => {
    if (!order || !session?.user?.email) return false;
    const res = await fetch(
      `${getApiBaseUrl()}/orders/${order.id}/shipping-label`,
      { headers: { email: session.user.email } },
    );
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  };

  const handleEmitirEtiqueta = async () => {
    if (!order || !session?.user?.email || labelLoading) return;
    setLabelLoading(true);
    setLabelMsg(null);
    setLabelError(null);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/orders/${order.id}/shipping-label`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
          body: JSON.stringify({ size: labelSize }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLabelError(
          data?.message ||
            "Não foi possível gerar a etiqueta. Tente novamente.",
        );
        return;
      }
      setLabelMsg(
        data?.reused
          ? "Etiqueta já gerada — abrindo para impressão."
          : "Etiqueta gerada — abrindo para impressão.",
      );
      const opened = await openLabelPdf();
      if (!opened) {
        setLabelError(
          "Etiqueta gerada, mas falhou ao abrir o PDF. Use 'Baixar'.",
        );
      }
    } catch {
      setLabelError("Erro de conexão ao gerar a etiqueta.");
    } finally {
      setLabelLoading(false);
    }
  };

  const handleBaixarEtiqueta = async () => {
    if (!order || labelLoading) return;
    setLabelError(null);
    const ok = await openLabelPdf();
    if (!ok) {
      setLabelError(
        "Nenhuma etiqueta gerada ainda. Clique em 'Emitir etiqueta'.",
      );
    }
  };

  const handleStatusUpdate = async (newStatus: OrderStatus) => {
    if (!order || !session?.user?.email) return;

    try {
      setIsUpdating(true);
      const response = await fetch(
        `${getApiBaseUrl()}/orders/${order.id}/status`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
          body: JSON.stringify({ status: newStatus }),
        },
      );

      if (!response.ok) throw new Error("Erro ao atualizar status");

      onOrderUpdate();
      onOpenChange(false);
    } catch (error) {
      console.error("Erro ao atualizar status:", error);
    } finally {
      setIsUpdating(false);
    }
  };

  const renderStatusBadge = (status: OrderStatus) => (
    <Badge
      variant="outline"
      className={statusStyles[status] || "border-border/70"}
    >
      {status}
    </Badge>
  );

  if (!order) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden border-l border-border/60 bg-gradient-to-b from-background via-background to-muted p-0 shadow-2xl sm:max-w-[900px] lg:max-w-[1100px]"
      >
        <SheetTitle className="sr-only">Detalhes do pedido</SheetTitle>
        <div className="relative flex h-full flex-col">
          <div className="relative isolate overflow-hidden border-b border-border/60 bg-gradient-to-r from-primary/12 via-primary/6 to-transparent pl-6 pr-12 pb-6 pt-6">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-48 bg-[radial-gradient(circle_at_top_left,theme(colors.primary/25),transparent_55%)] opacity-80"
            />

            <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-inner shadow-primary/20">
                    <Package className="size-5" />
                  </span>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Pedido
                    </p>
                    <p className="text-xl font-semibold leading-tight text-foreground">
                      {order.externalOrderId}
                    </p>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  Detalhes completos do pedido importado
                </p>

                <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                    <Clock className="size-3" />
                    Criado em {formatDateTime(order.createdAt)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                    <Clock className="size-3" />
                    Última atualização {formatDateTime(order.updatedAt)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-3 text-right">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {renderStatusBadge(order.status)}
                  <Select
                    defaultValue={order.status}
                    onValueChange={(value) =>
                      handleStatusUpdate(value as OrderStatus)
                    }
                    disabled={isUpdating}
                  >
                    <SelectTrigger className="min-w-[170px] border-border/70 bg-card/80 shadow-sm">
                      <SelectValue placeholder="Alterar status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">PENDING</SelectItem>
                      <SelectItem value="PAID">PAID</SelectItem>
                      <SelectItem value="SHIPPED">SHIPPED</SelectItem>
                      <SelectItem value="DELIVERED">DELIVERED</SelectItem>
                      <SelectItem value="CANCELLED">CANCELLED</SelectItem>
                    </SelectContent>
                  </Select>
                  {isFiscalEnabled && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleEmitirNfe}
                      disabled={isCreatingNfe}
                      className="gap-1.5"
                    >
                      {isCreatingNfe ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <FileText className="size-4" />
                      )}
                      {isCreatingNfe ? "Preparando..." : "Emitir NF-e"}
                    </Button>
                  )}
                </div>
                {nfeError && (
                  <p className="max-w-65 text-xs text-destructive">
                    {nfeError}
                  </p>
                )}
                {isEtiquetasEnabled && (
                  <div className="flex flex-col items-end gap-1.5">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Select
                        value={labelSize}
                        onValueChange={(value) =>
                          setLabelSize(value as "A4" | "THERMAL")
                        }
                        disabled={labelLoading}
                      >
                        <SelectTrigger className="min-w-[140px] border-border/70 bg-card/80 shadow-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="A4">Etiqueta A4</SelectItem>
                          <SelectItem value="THERMAL">Térmica 10×15</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleEmitirEtiqueta}
                        disabled={labelLoading}
                        className="gap-1.5"
                      >
                        {labelLoading ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Printer className="size-4" />
                        )}
                        {labelLoading ? "Gerando..." : "Emitir etiqueta"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleBaixarEtiqueta}
                        disabled={labelLoading}
                      >
                        Baixar
                      </Button>
                    </div>
                    {labelMsg && (
                      <p className="max-w-65 text-xs text-emerald-600 dark:text-emerald-400">
                        {labelMsg}
                      </p>
                    )}
                    {labelError && (
                      <p className="max-w-65 text-xs text-destructive">
                        {labelError}
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                    Total do Pedido
                  </p>
                  <p className="text-3xl font-semibold leading-tight text-foreground">
                    {formatCurrency(order.totalAmount)}
                  </p>
                </div>
              </div>
            </div>

            {order.marketplaceAccount ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-primary/50 bg-primary/10 text-xs font-medium uppercase tracking-[0.08em] text-primary"
                >
                  {order.marketplaceAccount.platform}
                </Badge>
                <span className="rounded-full border border-border/60 bg-card/70 px-3 py-1 text-xs text-muted-foreground">
                  {order.marketplaceAccount.accountName}
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-8 pt-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <User className="size-4" />
                  Cliente
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {order.customerName || "N/A"}
                </div>
                {order.customerEmail ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {order.customerEmail}
                  </p>
                ) : null}
              </div>

              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="size-4" />
                  Data do Pedido
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {formatDateTime(order.createdAt)}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  ID externo: {order.externalOrderId}
                </p>
              </div>

              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Store className="size-4" />
                  Marketplace
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {order.marketplaceAccount?.platform ?? "Não informado"}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {order.marketplaceAccount?.accountName ??
                    "Conta não vinculada"}
                </p>
              </div>

              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <DollarSign className="size-4" />
                  Resumo
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {formatCurrency(order.totalAmount)}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {order.items?.length ?? 0}{" "}
                  {order.items?.length === 1 ? "item" : "itens"} no pedido
                </p>
              </div>
            </div>

            <section className="rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                    Itens do Pedido
                  </p>
                  <p className="text-sm font-semibold text-foreground">
                    {order.items?.length
                      ? `${order.items.length} ${
                          order.items.length === 1 ? "item" : "itens"
                        }`
                      : "Nenhum item cadastrado"}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="bg-muted/40 text-[11px] font-medium text-muted-foreground"
                >
                  SKU · Quantidade · Total
                </Badge>
              </div>

              <div className="space-y-3 p-4">
                {order.items?.length ? (
                  order.items.map((item) => {
                    const locationLabel =
                      item.product?.productLocation?.code ??
                      item.product?.location ??
                      null;
                    const locationDescription =
                      item.product?.productLocation?.description ?? null;
                    const productName =
                      item.product?.name || "Produto não encontrado";
                    // Mesmo resolvedor do modal: URL canônica do ML (com hífen)
                    // quando falta permalink + gating. Sem listing vinculado
                    // (listingId nulo) não renderiza nada, como antes.
                    const linkState = item.listing
                      ? resolveMarketplaceListingLinkState({
                          platform: (item.listing.platform ??
                            order.marketplaceAccount?.platform ??
                            "MERCADO_LIVRE") as MarketplaceListingPlatform,
                          externalListingId: item.listing.externalListingId,
                          permalink: item.listing.permalink,
                          status: item.listing.status,
                        })
                      : null;
                    return (
                      <div
                        key={item.id}
                        className="flex flex-col gap-4 rounded-xl border border-border/60 bg-card p-3 transition hover:border-primary/40 sm:flex-row sm:items-center"
                      >
                        <div className="flex items-start gap-3 sm:flex-1">
                          <ItemThumb
                            src={item.product?.imageUrl ?? null}
                            alt={productName}
                          />
                          <div className="min-w-0 space-y-1.5">
                            <p className="font-semibold leading-snug text-foreground">
                              {productName}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono text-muted-foreground">
                                {item.product?.sku || "N/A"}
                              </span>
                              {locationLabel ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-medium text-foreground"
                                  title={locationDescription ?? undefined}
                                >
                                  <MapPin className="size-3 text-muted-foreground" />
                                  {locationLabel}
                                </span>
                              ) : null}
                            </div>
                            {linkState ? (
                              linkState.isOpenable && linkState.href ? (
                                <a
                                  href={linkState.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                >
                                  <ExternalLink className="size-3" />
                                  Ver anúncio
                                </a>
                              ) : (
                                <span
                                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground"
                                  title={linkState.disabledReason ?? undefined}
                                >
                                  <ExternalLink className="size-3" />
                                  Ver anúncio
                                </span>
                              )
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center justify-between gap-5 border-t border-border/60 pt-3 sm:justify-end sm:border-t-0 sm:pt-0">
                          <div className="text-center">
                            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                              Qtd
                            </p>
                            <p className="text-sm font-medium text-foreground">
                              {item.quantity}
                            </p>
                          </div>
                          <div className="text-center">
                            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                              Preço Unit.
                            </p>
                            <p className="text-sm font-medium text-foreground">
                              {formatCurrency(item.unitPrice)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                              Total
                            </p>
                            <p className="text-sm font-semibold text-foreground">
                              {formatCurrency(item.quantity * item.unitPrice)}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
                    <Package className="size-4" />
                    Nenhum item vinculado a este pedido.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
