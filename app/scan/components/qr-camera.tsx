"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, CameraOff, Loader2, RotateCcw } from "lucide-react";

interface QrCameraProps {
  onDetect: (text: string) => void;
  onError?: (err: Error) => void;
  paused?: boolean;
}

type Phase = "idle" | "requesting" | "running" | "error";

interface VideoDevice {
  deviceId: string;
  label: string;
}

export function QrCamera({ onDetect, onError, paused }: QrCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<any>(null);
  const controlsRef = useRef<any>(null);
  const lastDetectionRef = useRef<{ text: string; at: number } | null>(null);
  const devicesCacheRef = useRef<VideoDevice[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<VideoDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const stopReader = useCallback(() => {
    try {
      if (controlsRef.current) {
        controlsRef.current.stop();
        controlsRef.current = null;
      }
    } catch {
      // ignore
    }
  }, []);

  const startReader = useCallback(
    async (targetDeviceId?: string) => {
      setErrorMessage(null);
      setPhase("requesting");
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (!readerRef.current) {
          readerRef.current = new BrowserQRCodeReader();
        }

        // Cache de devices: a lista raramente muda entre re-starts no mesmo
        // device. Re-enumera apenas no primeiro start ou ao trocar câmera
        // explicitamente (targetDeviceId definido).
        let mapped: VideoDevice[] = devicesCacheRef.current;
        if (mapped.length === 0) {
          const allDevices =
            await BrowserQRCodeReader.listVideoInputDevices();
          mapped = allDevices.map((d) => ({
            deviceId: d.deviceId,
            label: d.label || "Câmera",
          }));
          devicesCacheRef.current = mapped;
          setDevices(mapped);
        }

        // Preferir câmera traseira no mobile
        const back = mapped.find((d) =>
          /back|traseira|environment/i.test(d.label),
        );
        const chosen =
          targetDeviceId || back?.deviceId || mapped[0]?.deviceId || null;
        setDeviceId(chosen);

        if (!videoRef.current) {
          throw new Error("Elemento de vídeo não disponível");
        }

        stopReader();

        controlsRef.current = await readerRef.current.decodeFromVideoDevice(
          chosen ?? undefined,
          videoRef.current,
          (result: any, err: any) => {
            if (result) {
              const text = result.getText();
              const now = Date.now();
              const last = lastDetectionRef.current;
              if (last && last.text === text && now - last.at < 2000) {
                return;
              }
              lastDetectionRef.current = { text, at: now };
              onDetect(text);
            }
            // err é frequentemente "NotFoundException" entre frames — ignorar
            void err;
          },
        );

        setPhase("running");
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setPhase("error");
        setErrorMessage(err.message || "Não foi possível acessar a câmera");
        onError?.(err);
      }
    },
    [onDetect, onError, stopReader],
  );

  useEffect(() => {
    return () => {
      stopReader();
    };
  }, [stopReader]);

  // Pausar/retomar conforme prop
  useEffect(() => {
    if (paused && phase === "running") {
      stopReader();
      setPhase("idle");
    }
  }, [paused, phase, stopReader]);

  const handleSwitchCamera = async () => {
    if (devices.length < 2 || !deviceId) return;
    const idx = devices.findIndex((d) => d.deviceId === deviceId);
    const next = devices[(idx + 1) % devices.length];
    await startReader(next.deviceId);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-border/60 bg-black/90">
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          playsInline
          muted
        />
        {phase !== "running" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
            {phase === "idle" && (
              <>
                <Camera className="size-10 opacity-80" />
                <p className="text-sm">Câmera desligada</p>
                <Button
                  onClick={() => startReader()}
                  size="sm"
                  variant="secondary"
                >
                  <Camera className="mr-2 size-4" />
                  Iniciar câmera
                </Button>
              </>
            )}
            {phase === "requesting" && (
              <>
                <Loader2 className="size-10 animate-spin opacity-80" />
                <p className="text-sm">Solicitando permissão…</p>
              </>
            )}
            {phase === "error" && (
              <>
                <CameraOff className="size-10 opacity-80" />
                <p className="px-4 text-center text-sm">
                  {errorMessage || "Erro ao acessar câmera"}
                </p>
                <Button
                  onClick={() => startReader()}
                  size="sm"
                  variant="secondary"
                >
                  Tentar novamente
                </Button>
              </>
            )}
          </div>
        )}
        {/* Guia visual de mira */}
        {phase === "running" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="size-3/5 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}
      </div>

      {phase === "running" && devices.length > 1 && (
        <Button onClick={handleSwitchCamera} variant="outline" size="sm">
          <RotateCcw className="mr-2 size-4" />
          Trocar câmera
        </Button>
      )}
    </div>
  );
}

export default QrCamera;
