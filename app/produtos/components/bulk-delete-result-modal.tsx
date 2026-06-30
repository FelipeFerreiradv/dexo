"use client";

import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface BulkDeleteListingResultView {
  listingId: string;
  externalListingId: string;
  platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU" | null;
  closed: boolean;
  error?: string;
  retryable?: boolean;
}

export interface BulkDeleteProductResultView {
  productId: string;
  deleted: boolean;
  message: string;
  listingResults: BulkDeleteListingResultView[];
}

interface BulkDeleteResultModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  results: BulkDeleteProductResultView[];
  summary: { total: number; deleted: number; failed: number };
  productNames?: Record<string, string>;
  onRetry?: (failedIds: string[]) => void;
  isRetrying?: boolean;
}

const platformLabel = (p: BulkDeleteListingResultView["platform"]): string => {
  if (p === "MERCADO_LIVRE") return "Mercado Livre";
  if (p === "SHOPEE") return "Shopee";
  if (p === "MAGALU") return "Magalu";
  return "Marketplace";
};

export function BulkDeleteResultModal({
  open,
  onOpenChange,
  results,
  summary,
  productNames,
  onRetry,
  isRetrying = false,
}: BulkDeleteResultModalProps) {
  const failed = results.filter((r) => !r.deleted);
  const failedIds = failed.map((r) => r.productId);
  const canRetry = failed.length > 0 && typeof onRetry === "function";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Resultado da exclusão</DialogTitle>
          <DialogDescription>
            {summary.deleted} excluído(s) · {summary.failed} mantido(s) ·{" "}
            {summary.total} total
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {results.map((r) => (
            <ProductResultRow
              key={r.productId}
              result={r}
              name={productNames?.[r.productId]}
            />
          ))}
        </div>

        {failed.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Os produtos marcados como{" "}
            <span className="font-medium text-red-600">não excluídos</span> ainda
            estão no Dexo. Reintente quando o erro abaixo for resolvido — ou
            confira o anúncio diretamente no marketplace para entender o motivo.
          </p>
        )}

        <DialogFooter>
          {canRetry && (
            <Button
              variant="default"
              onClick={() => onRetry?.(failedIds)}
              disabled={isRetrying}
            >
              <RefreshCw
                className={cn("mr-2 h-4 w-4", isRetrying && "animate-spin")}
              />
              Reintentar {failed.length} falha(s)
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductResultRow({
  result,
  name,
}: {
  result: BulkDeleteProductResultView;
  name?: string;
}) {
  const displayName = name ?? result.productId;
  const failedListings = result.listingResults.filter((l) => !l.closed);

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        result.deleted
          ? "border-emerald-200 bg-emerald-50/40"
          : "border-red-200 bg-red-50/40",
      )}
    >
      <div className="flex items-start gap-2">
        {result.deleted ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        ) : (
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{displayName}</p>
          <p className="text-xs text-muted-foreground">{result.message}</p>
        </div>
      </div>

      {failedListings.length > 0 && (
        <ul className="mt-2 ml-7 space-y-1.5 text-xs">
          {failedListings.map((l) => (
            <li key={l.listingId} className="flex items-start gap-2">
              <Badge
                variant={l.retryable ? "secondary" : "destructive"}
                className="shrink-0 text-[10px]"
              >
                {l.retryable ? "Recuperável" : "Definitivo"}
              </Badge>
              <span className="min-w-0 text-muted-foreground">
                <span className="font-mono text-foreground">
                  {platformLabel(l.platform)} · {l.externalListingId}
                </span>
                {" — "}
                {l.error ?? "Erro desconhecido"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
