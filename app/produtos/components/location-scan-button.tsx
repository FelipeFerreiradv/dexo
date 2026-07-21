"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { QrCode } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiBaseUrl } from "@/lib/api";
import {
  decideLocationScan,
  type ScanResolveData,
} from "@/app/produtos/lib/location-scan-decision";
import type { LocationSelectItem } from "@/app/produtos/lib/location-select-filter";

// Mesmo padrão de consumo do scan-receive-flow: zxing só entra no chunk quando
// o scanner abre, e nunca no SSR.
const QrCamera = dynamic(
  () => import("@/app/scan/components/qr-camera").then((m) => m.QrCamera),
  {
    ssr: false,
    loading: () => <Skeleton className="aspect-square w-full rounded-lg" />,
  },
);

interface LocationScanButtonProps {
  options: LocationSelectItem[];
  /** Valor VIVO de `locationId` no form (isenção de lotada — paridade combobox). */
  currentLocationId: string | null;
  onResolved: (loc: { id: string; code: string; fullPath: string }) => void;
  onToast: (message: string, type: "success" | "error" | "warning") => void;
  disabled?: boolean;
}

/**
 * Botão que abre um modal com o QrCamera para selecionar a localização do
 * produto lendo o QR da etiqueta, em vez de abrir o combobox. A resolução é
 * server-side via `GET /scan/resolve` (mesmo caminho do fluxo de receber por
 * scan); ao reconhecer uma localização válida, entrega id+code+fullPath ao
 * chamador — que grava o MESMO par FK `locationId` + texto `location` do
 * onChange do combobox.
 */
export function LocationScanButton({
  options,
  currentLocationId,
  onResolved,
  onToast,
  disabled,
}: LocationScanButtonProps) {
  const { data: session } = useSession();
  const email = session?.user?.email;

  const [open, setOpen] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const lastTextRef = useRef<{ text: string; at: number } | null>(null);

  const handleDetect = useCallback(
    async (text: string) => {
      if (!email) return;
      // Segunda camada de de-dupe (além da do QrCamera), como no receive-flow.
      const now = Date.now();
      const last = lastTextRef.current;
      if (last && last.text === text && now - last.at < 2000) return;
      lastTextRef.current = { text, at: now };

      setIsResolving(true);
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/scan/resolve?payload=${encodeURIComponent(text)}`,
          { headers: { email } },
        );
        // 404 traz corpo { error, kind } e é resposta válida a interpretar.
        if (!res.ok && res.status !== 404) {
          throw new Error("Erro ao resolver QR escaneado");
        }
        const data = (await res.json()) as ScanResolveData;
        const decision = decideLocationScan(data, options, currentLocationId);
        if (decision.type === "select") {
          onResolved(decision);
          onToast(`Localização "${decision.code}" selecionada`, "success");
          // Fechar desmonta o DialogContent → cleanup do QrCamera desliga a câmera.
          setOpen(false);
        } else {
          onToast(decision.message, decision.tone);
        }
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Erro ao resolver QR", "error");
      } finally {
        setIsResolving(false);
      }
    },
    [email, options, currentLocationId, onResolved, onToast],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          // Pré-aquece o chunk do zxing em paralelo com o mount do QrCamera;
          // o import dentro do startReader resolve do cache de módulos.
          void import("@zxing/browser").catch(() => {});
        }
        // Reabrir permite re-escanear o mesmo QR imediatamente.
        if (!o) lastTextRef.current = null;
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          disabled={disabled}
          aria-label="Escanear QR da localização"
          title="Escanear QR da localização"
        >
          <QrCode className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Escanear localização</DialogTitle>
          <DialogDescription>
            Aponte a câmera para o QR Code da etiqueta da localização.
          </DialogDescription>
        </DialogHeader>
        <QrCamera onDetect={handleDetect} paused={isResolving} />
      </DialogContent>
    </Dialog>
  );
}
