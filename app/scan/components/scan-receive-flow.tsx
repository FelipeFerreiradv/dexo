"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  CheckCircle2,
  ChevronLeft,
  Loader2,
  MapPin,
  Package,
  RefreshCcw,
  Undo2,
  X,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiBaseUrl } from "@/lib/api";
import { parseScannedPayload } from "@/app/lib/qr-payloads";

const QrCamera = dynamic(
  () => import("./qr-camera").then((m) => m.QrCamera),
  {
    ssr: false,
    loading: () => <Skeleton className="aspect-square w-full rounded-lg" />,
  },
);

// ───────────────── Types ─────────────────

interface ResolvedLocation {
  id: string;
  code: string;
  description: string | null;
  maxCapacity: number;
  productsCount: number;
  isFull: boolean;
}

interface ResolvedProduct {
  id: string;
  sku: string;
  name: string;
  imageUrl: string | null;
  currentLocationId: string | null;
  currentLocationCode: string | null;
}

interface AttachedEntry {
  product: ResolvedProduct;
  attachedAt: number;
  alreadyAttached?: boolean;
}

interface SkippedEntry {
  text: string;
  reason: string;
  scannedAt: number;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "info" | "error";
}

type Phase = "select-location" | "scanning-products" | "done";

// ───────────────── Component ─────────────────

interface ScanReceiveFlowProps {
  initialLocationId?: string;
}

export function ScanReceiveFlow({ initialLocationId }: ScanReceiveFlowProps) {
  const { data: session } = useSession();
  const email = session?.user?.email;

  const [phase, setPhase] = useState<Phase>("select-location");
  const [targetLocation, setTargetLocation] = useState<ResolvedLocation | null>(
    null,
  );
  const [attached, setAttached] = useState<AttachedEntry[]>([]);
  const [skipped, setSkipped] = useState<SkippedEntry[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [manualInput, setManualInput] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [scanPaused, setScanPaused] = useState(false);

  const seenProductIdsRef = useRef<Set<string>>(new Set());
  const lastTextRef = useRef<{ text: string; at: number } | null>(null);

  const showToast = useCallback(
    (message: string, type: Toast["type"] = "info") => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t-${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3500);
    },
    [],
  );

  const resolvePayload = useCallback(
    async (text: string) => {
      if (!email) return null;
      const apiBase = getApiBaseUrl();
      const res = await fetch(
        `${apiBase}/scan/resolve?payload=${encodeURIComponent(text)}`,
        { headers: { email } },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error("Erro ao resolver QR escaneado");
      }
      return res.json();
    },
    [email],
  );

  const handleLocationScan = useCallback(
    async (text: string) => {
      if (!email) return;
      const now = Date.now();
      const last = lastTextRef.current;
      if (last && last.text === text && now - last.at < 2000) return;
      lastTextRef.current = { text, at: now };

      setIsResolving(true);
      try {
        const data = await resolvePayload(text);
        if (!data) return;
        if (data.kind === "location" && data.location) {
          setTargetLocation(data.location);
          setAttached([]);
          setSkipped([]);
          seenProductIdsRef.current = new Set();
          setPhase("scanning-products");
          showToast(`Localização "${data.location.code}" travada`, "success");
        } else if (data.kind === "product") {
          showToast("Esse é um QR de produto — escaneie a localização primeiro.", "error");
        } else {
          showToast("QR não reconhecido como localização.", "error");
        }
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : "Erro ao resolver QR",
          "error",
        );
      } finally {
        setIsResolving(false);
      }
    },
    [email, resolvePayload, showToast],
  );

  const handleProductScan = useCallback(
    async (text: string) => {
      if (!email || !targetLocation) return;
      const now = Date.now();
      const last = lastTextRef.current;
      if (last && last.text === text && now - last.at < 2000) return;
      lastTextRef.current = { text, at: now };

      try {
        // Otimização: parser client-side detecta URLs completas e CUID puro
        // sem round-trip extra. Só caímos no /scan/resolve quando precisamos
        // diferenciar product de location (CUID puro).
        const parsed = parseScannedPayload(text);

        if (parsed.kind === "location") {
          showToast(
            "Esse é um QR de localização — use 'Trocar localização'.",
            "info",
          );
          return;
        }

        let productIdToAttach: string | null = null;
        let productPreview: ResolvedProduct | null = null;

        if (parsed.kind === "product" && parsed.id) {
          // URL completa de produto: curto-circuita, vai direto pro attach.
          // Backend trata tenant/idempotência via skipped/alreadyAttached.
          productIdToAttach = parsed.id;
        } else if (parsed.id) {
          // CUID puro: usa /scan/resolve para diferenciar product de location
          const data = await resolvePayload(text);
          if (!data) return;
          if (data.kind === "location") {
            showToast(
              "Esse é um QR de localização — use 'Trocar localização'.",
              "info",
            );
            return;
          }
          if (data.kind !== "product" || !data.product) {
            setSkipped((prev) => [
              { text, reason: "QR não reconhecido", scannedAt: now },
              ...prev,
            ]);
            showToast("QR não reconhecido", "error");
            return;
          }
          productIdToAttach = data.product.id;
          productPreview = data.product;
        } else {
          // Payload irreconhecível
          setSkipped((prev) => [
            { text, reason: "QR não reconhecido", scannedAt: now },
            ...prev,
          ]);
          showToast("QR não reconhecido", "error");
          return;
        }

        // Chama attach-products com 1 item (backend é idempotente)
        const apiBase = getApiBaseUrl();
        const res = await fetch(
          `${apiBase}/locations/${targetLocation.id}/attach-products`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", email },
            body: JSON.stringify({ productIds: [productIdToAttach] }),
          },
        );
        const body = await res.json();
        if (!res.ok) {
          if (res.status === 422) {
            showToast(
              body.error || "Capacidade da localização excedida",
              "error",
            );
            setSkipped((prev) => [
              {
                text: productPreview?.sku || productIdToAttach!,
                reason: "Capacidade excedida",
                scannedAt: now,
              },
              ...prev,
            ]);
            return;
          }
          throw new Error(body.error || "Erro ao vincular produto");
        }

        // Resposta autoritativa do attach
        const attachedRef = body.attached?.[0];
        const alreadyRef = body.alreadyAttached?.[0];
        const skipRef = body.skipped?.[0];
        const ref = attachedRef || alreadyRef;
        const isAlready = !attachedRef && !!alreadyRef;

        if (skipRef && !ref) {
          // Produto não encontrado (de outro tenant ou ID inválido)
          setSkipped((prev) => [
            {
              text: productPreview?.sku || skipRef.productId,
              reason: "Produto não encontrado",
              scannedAt: now,
            },
            ...prev,
          ]);
          showToast("Produto não reconhecido", "error");
          return;
        }

        if (!ref) return;

        const product: ResolvedProduct = productPreview ?? {
          id: ref.id,
          sku: ref.sku,
          name: ref.name,
          imageUrl: null,
          currentLocationId: targetLocation.id,
          currentLocationCode: targetLocation.code,
        };

        seenProductIdsRef.current.add(product.id);

        setAttached((prev) => [
          { product, attachedAt: now, alreadyAttached: isAlready },
          ...prev,
        ]);
        if (body.location) {
          setTargetLocation((prev) =>
            prev
              ? {
                  ...prev,
                  productsCount: body.location.productsCount,
                  isFull:
                    prev.maxCapacity > 0 &&
                    body.location.productsCount >= prev.maxCapacity,
                }
              : prev,
          );
        }
        showToast(
          isAlready
            ? `${product.sku} já estava aqui`
            : `${product.sku} vinculado`,
          isAlready ? "info" : "success",
        );
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : "Erro ao vincular produto",
          "error",
        );
      }
    },
    [email, resolvePayload, showToast, targetLocation],
  );

  // Resolver location inicial quando vier por URL
  useEffect(() => {
    if (!initialLocationId || !email || phase !== "select-location") return;
    void handleLocationScan(initialLocationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLocationId, email]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = manualInput.trim();
    if (!text) return;
    if (phase === "select-location") {
      void handleLocationScan(text);
    } else if (phase === "scanning-products") {
      void handleProductScan(text);
    }
    setManualInput("");
  };

  const handleChangeLocation = () => {
    setPhase("select-location");
    setTargetLocation(null);
    setAttached([]);
    setSkipped([]);
    seenProductIdsRef.current = new Set();
    lastTextRef.current = null;
  };

  const handleUndoLast = async () => {
    if (!targetLocation || !email || attached.length === 0) return;
    const last = attached.find((a) => !a.alreadyAttached);
    if (!last) {
      showToast("Nada para desfazer nesta sessão", "info");
      return;
    }
    setIsUndoing(true);
    try {
      const apiBase = getApiBaseUrl();
      const res = await fetch(`${apiBase}/locations/move-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({
          productIds: [last.product.id],
          targetLocationId: null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Erro ao desfazer");
      seenProductIdsRef.current.delete(last.product.id);
      setAttached((prev) => prev.filter((a) => a !== last));
      setTargetLocation((prev) =>
        prev
          ? {
              ...prev,
              productsCount: Math.max(0, prev.productsCount - 1),
              isFull:
                prev.maxCapacity > 0 &&
                Math.max(0, prev.productsCount - 1) >= prev.maxCapacity,
            }
          : prev,
      );
      showToast(`${last.product.sku} desvinculado`, "info");
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Erro ao desfazer",
        "error",
      );
    } finally {
      setIsUndoing(false);
    }
  };

  const handleFinish = () => {
    setPhase("done");
    setScanPaused(true);
  };

  const handleStartOver = () => {
    setPhase("select-location");
    setTargetLocation(null);
    setAttached([]);
    setSkipped([]);
    seenProductIdsRef.current = new Set();
    lastTextRef.current = null;
    setScanPaused(false);
  };

  const attachedCount = useMemo(
    () => attached.filter((a) => !a.alreadyAttached).length,
    [attached],
  );

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
                : toast.type === "info"
                  ? "bg-blue-100 text-blue-800 dark:bg-blue-900/80 dark:text-blue-200"
                  : "bg-destructive text-white"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      {phase === "select-location" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="size-5" />
              Passo 1 — escaneie o QR da localização
            </CardTitle>
            <CardDescription>
              Aponte a câmera para a etiqueta colada na caixa, prateleira ou
              galpão de destino.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[1fr_320px]">
              <QrCamera
                onDetect={handleLocationScan}
                paused={scanPaused || isResolving}
              />
              <div className="space-y-3">
                <form onSubmit={handleManualSubmit} className="space-y-2">
                  <Label htmlFor="manual-loc">Ou cole o código/URL</Label>
                  <Input
                    id="manual-loc"
                    placeholder="Cole aqui ou digite o ID"
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isResolving || !manualInput.trim()}
                  >
                    {isResolving ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : null}
                    Buscar localização
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">
                  Você também pode escanear o QR direto pela câmera nativa do
                  celular — abrirá esta tela já com a localização travada.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {phase === "scanning-products" && targetLocation && (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <MapPin className="size-5 text-primary" />
                    {targetLocation.code}
                  </CardTitle>
                  {targetLocation.description && (
                    <CardDescription>
                      {targetLocation.description}
                    </CardDescription>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleChangeLocation}
                  >
                    <ChevronLeft className="mr-1 size-3.5" />
                    Trocar localização
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
                <div className="text-sm">
                  <span className="font-semibold">
                    {targetLocation.productsCount}
                  </span>
                  {targetLocation.maxCapacity > 0 ? (
                    <span className="text-muted-foreground">
                      {" "}
                      / {targetLocation.maxCapacity} produto(s)
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {" "}
                      produto(s) · sem limite
                    </span>
                  )}
                </div>
                {targetLocation.maxCapacity > 0 && (
                  <Progress
                    value={Math.min(
                      100,
                      Math.round(
                        (targetLocation.productsCount /
                          targetLocation.maxCapacity) *
                          100,
                      ),
                    )}
                    className="h-2 max-w-xs flex-1"
                  />
                )}
                {targetLocation.isFull && (
                  <span className="text-xs font-semibold text-destructive">
                    Cheia
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="size-5" />
                Passo 2 — escaneie cada produto
              </CardTitle>
              <CardDescription>
                Cada QR de produto lido é vinculado automaticamente a esta
                localização.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-[1fr_320px]">
                <QrCamera onDetect={handleProductScan} paused={scanPaused} />
                <div className="space-y-3">
                  <form onSubmit={handleManualSubmit} className="space-y-2">
                    <Label htmlFor="manual-prod">Ou cole o código/URL</Label>
                    <Input
                      id="manual-prod"
                      placeholder="SKU, ID ou URL do produto"
                      value={manualInput}
                      onChange={(e) => setManualInput(e.target.value)}
                    />
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={!manualInput.trim()}
                    >
                      Vincular
                    </Button>
                  </form>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleUndoLast}
                      disabled={isUndoing || attached.length === 0}
                    >
                      <Undo2 className="mr-1.5 size-3.5" />
                      Desfazer último
                    </Button>
                    <Button
                      size="sm"
                      variant="default"
                      onClick={handleFinish}
                      disabled={attached.length === 0}
                    >
                      <CheckCircle2 className="mr-1.5 size-3.5" />
                      Concluir ({attachedCount})
                    </Button>
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Histórico desta sessão</h4>
                {attached.length === 0 && skipped.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Nada escaneado ainda.
                  </p>
                )}
                <ul className="max-h-60 space-y-1 overflow-y-auto">
                  {attached.map((entry) => (
                    <li
                      key={`${entry.product.id}-${entry.attachedAt}`}
                      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-1.5 text-sm ${
                        entry.alreadyAttached
                          ? "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-900/30"
                          : "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-900/30"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {entry.alreadyAttached ? (
                          <CheckCircle2 className="size-4 shrink-0 text-blue-700 dark:text-blue-300" />
                        ) : (
                          <CheckCircle2 className="size-4 shrink-0 text-green-700 dark:text-green-300" />
                        )}
                        <span className="truncate font-medium">
                          {entry.product.sku}
                        </span>
                        <span className="truncate text-muted-foreground">
                          — {entry.product.name}
                        </span>
                      </div>
                      <time className="shrink-0 text-xs text-muted-foreground">
                        {new Date(entry.attachedAt).toLocaleTimeString()}
                      </time>
                    </li>
                  ))}
                  {skipped.map((entry, idx) => (
                    <li
                      key={`skip-${idx}-${entry.scannedAt}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm dark:border-red-900 dark:bg-red-900/30"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <XCircle className="size-4 shrink-0 text-red-700 dark:text-red-300" />
                        <span className="truncate font-medium">
                          {entry.text || "—"}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {entry.reason}
                        </span>
                      </div>
                      <time className="shrink-0 text-xs text-muted-foreground">
                        {new Date(entry.scannedAt).toLocaleTimeString()}
                      </time>
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {phase === "done" && targetLocation && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-green-600" />
              Sessão concluída
            </CardTitle>
            <CardDescription>
              {attachedCount} produto(s) vinculado(s) à localização &quot;
              {targetLocation.code}&quot;.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={handleStartOver}>
              <RefreshCcw className="mr-2 size-4" />
              Receber em outra localização
            </Button>
            <Button asChild variant="outline">
              <Link href="/localizacoes">
                <X className="mr-2 size-4" />
                Voltar para Localizações
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
