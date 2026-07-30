"use client";

/**
 * useFabricEditor — ciclo de vida do canvas fabric do Editor (PR 6).
 *
 * DECISÕES:
 * - O canvas LÓGICO tem as dimensões FINAIS do export (ex.: 1200×1200) e é
 *   encolhido só via CSS (`setDimensions cssOnly`) — o export usa
 *   multiplier 1 e sai pixel-perfect, sem reescala de bitmap.
 * - fabric v6+ removeu gestures do core: pinch/pan são nossos, via Pointer
 *   Events + `touch-action:none` (uso real = celular no pátio). A conta pura
 *   vive em pointer-math.ts.
 * - A imagem-base é um objeto fabric NORMAL (controles nativos de mover/
 *   escalar/rotacionar) — o PR 7 adiciona camadas por cima.
 * - `crossOrigin:"anonymous"`: os uploads vivem no origin da API (≠ front);
 *   sem isso o canvas fica TAINTED e o toDataURL do save lança SecurityError.
 *   O CORS global do Fastify já cobre o estático /uploads.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas, FabricImage, Point } from "fabric";

import {
  type EditRecipeBaseTransform,
  initialBaseTransform,
} from "./recipe";
import {
  type EditorBackground,
} from "./presets";
import {
  type PinchState,
  type PointerPoint,
  beginPinch,
  clampZoom,
  midpoint,
  pinchZoom,
  wheelZoom,
} from "./pointer-math";

export interface FabricEditorOptions {
  /** URL da imagem-base (recorte PNG ou processada). */
  imageUrl: string | null;
  /** Dimensões LÓGICAS (finais) do canvas. */
  canvasWidth: number;
  canvasHeight: number;
  background: EditorBackground;
  paddingPct: number;
  /** Transform inicial da base (reabrir edição); null = auto-fit. */
  initialBase?: EditRecipeBaseTransform | null;
  onError?: (message: string) => void;
}

export interface FabricEditorApi {
  /** Ref para o <canvas>. */
  canvasElRef: (el: HTMLCanvasElement | null) => void;
  /** Ref para o wrapper (gestos + medida do espaço disponível). */
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  ready: boolean;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToFit: () => void;
  rotateBase: (deltaDeg: number) => void;
  refitBase: (paddingPct: number) => void;
  resetBase: (paddingPct: number) => void;
  /** Transform ATUAL da base (para a receita do save). */
  readBaseTransform: () => EditRecipeBaseTransform | null;
  /** Export nas dimensões lógicas, ignorando o zoom de visualização. */
  exportImage: (format: "png" | "jpeg", quality?: number) => string | null;
}

const bgColorOf = (bg: EditorBackground): string | undefined => {
  if (bg.mode === "white") return "#ffffff";
  if (bg.mode === "color") return bg.color ?? "#ffffff";
  return undefined; // transparent
};

export function useFabricEditor(opts: FabricEditorOptions): FabricEditorApi {
  const canvasRef = useRef<Canvas | null>(null);
  const baseImageRef = useRef<FabricImage | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  // Guarda os últimos opts que exigem re-init pesado (tamanho do canvas).
  const { canvasWidth, canvasHeight, imageUrl, paddingPct } = opts;
  const initialBaseRef = useRef(opts.initialBase ?? null);
  initialBaseRef.current = opts.initialBase ?? null;

  /** Encolhe o canvas via CSS para caber no wrapper (lógico intocado). */
  const fitDisplay = useCallback(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const available = wrapper.clientWidth;
    const availableH = Math.max(200, wrapper.clientHeight);
    if (available <= 0) return;
    const scale = Math.min(
      available / canvasWidth,
      availableH / canvasHeight,
      1,
    );
    canvas.setDimensions(
      {
        width: `${Math.round(canvasWidth * scale)}px`,
        height: `${Math.round(canvasHeight * scale)}px`,
      },
      { cssOnly: true },
    );
  }, [canvasWidth, canvasHeight]);

  const canvasElRef = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (!el) return;
      if (canvasRef.current) return; // já inicializado neste mount
      const canvas = new Canvas(el, {
        width: canvasWidth,
        height: canvasHeight,
        preserveObjectStacking: true,
        selection: false,
        // O export usa multiplier explícito; retina no display é só CSS.
        enableRetinaScaling: false,
      });
      canvasRef.current = canvas;
      fitDisplay();
    },
    [canvasWidth, canvasHeight, fitDisplay],
  );

  // Carrega/recarrega a imagem-base quando a URL ou o canvas lógico mudam.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageUrl) return;
    let cancelled = false;

    // Redimensiona o canvas lógico (troca de preset) antes de posicionar.
    canvas.setDimensions({ width: canvasWidth, height: canvasHeight });
    fitDisplay();

    FabricImage.fromURL(imageUrl, { crossOrigin: "anonymous" })
      .then((img) => {
        if (cancelled) return;
        if (baseImageRef.current) {
          canvas.remove(baseImageRef.current);
          baseImageRef.current = null;
        }
        const source = {
          width: img.width ?? 1,
          height: img.height ?? 1,
        };
        const base =
          initialBaseRef.current ??
          initialBaseTransform(
            { width: canvasWidth, height: canvasHeight },
            source,
            paddingPct,
          );
        img.set({
          originX: "center",
          originY: "center",
          left: base.left,
          top: base.top,
          scaleX: base.scaleX,
          scaleY: base.scaleY,
          angle: base.angle,
          flipX: base.flipX ?? false,
          flipY: base.flipY ?? false,
          // Controles nativos do fabric = mover/escalar/rotacionar a peça.
          selectable: true,
          centeredScaling: true,
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        baseImageRef.current = img;
        canvas.requestRenderAll();
        setReady(true);
      })
      .catch((err) => {
        console.error("[image-editor] falha ao carregar imagem:", err);
        onErrorRef.current?.(
          "Não foi possível carregar a imagem no editor. Tente novamente.",
        );
      });

    return () => {
      cancelled = true;
    };
    // paddingPct de propósito FORA das deps: mudar a margem não recarrega a
    // imagem — o slider chama refitBase explicitamente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, canvasWidth, canvasHeight, fitDisplay]);

  // Cor de fundo reativa (não recarrega nada).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.backgroundColor = bgColorOf(opts.background) ?? "";
    canvas.requestRenderAll();
  }, [opts.background]);

  // Dispose no unmount do dialog.
  useEffect(() => {
    return () => {
      const canvas = canvasRef.current;
      canvasRef.current = null;
      baseImageRef.current = null;
      if (canvas) void canvas.dispose();
    };
  }, []);

  // ---- Zoom/pan (roda + pinch + pan de 2 dedos) ---------------------------
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const pointers = new Map<number, PointerPoint>();
    let pinch: PinchState | null = null;
    let lastMid: { x: number; y: number } | null = null;

    const applyZoom = (z: number, originX: number, originY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.zoomToPoint(new Point(originX, originY), z);
      setZoom(z);
    };

    const onWheel = (e: WheelEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      e.preventDefault();
      const rect = wrapper.getBoundingClientRect();
      applyZoom(
        wheelZoom(canvas.getZoom(), e.deltaY),
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const canvas = canvasRef.current;
        const [a, b] = [...pointers.values()];
        pinch = canvas ? beginPinch(a, b, canvas.getZoom()) : null;
        lastMid = midpoint(a, b);
        // Dois dedos = gesto de tela; desabilita o drag de objeto do fabric.
        if (canvas) canvas.discardActiveObject();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
      const canvas = canvasRef.current;
      if (!canvas || pointers.size !== 2 || !pinch) return;
      e.preventDefault();
      const [a, b] = [...pointers.values()];
      const rect = wrapper.getBoundingClientRect();
      const mid = midpoint(a, b);
      applyZoom(
        pinchZoom(pinch, a, b),
        mid.x - rect.left,
        mid.y - rect.top,
      );
      // Pan: segue o deslocamento do ponto médio.
      if (lastMid) {
        const vpt = canvas.viewportTransform;
        if (vpt) {
          vpt[4] += mid.x - lastMid.x;
          vpt[5] += mid.y - lastMid.y;
          canvas.setViewportTransform(vpt);
        }
      }
      lastMid = mid;
    };

    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        pinch = null;
        lastMid = null;
      }
    };

    wrapper.addEventListener("wheel", onWheel, { passive: false });
    wrapper.addEventListener("pointerdown", onPointerDown);
    wrapper.addEventListener("pointermove", onPointerMove);
    wrapper.addEventListener("pointerup", onPointerEnd);
    wrapper.addEventListener("pointercancel", onPointerEnd);
    return () => {
      wrapper.removeEventListener("wheel", onWheel);
      wrapper.removeEventListener("pointerdown", onPointerDown);
      wrapper.removeEventListener("pointermove", onPointerMove);
      wrapper.removeEventListener("pointerup", onPointerEnd);
      wrapper.removeEventListener("pointercancel", onPointerEnd);
    };
  }, []);

  // Reajusta o display quando a janela muda de tamanho.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fitDisplay());
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [fitDisplay]);

  const setCanvasZoom = useCallback((z: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const clamped = clampZoom(z);
    canvas.zoomToPoint(
      new Point(canvasWidth / 2, canvasHeight / 2),
      clamped,
    );
    setZoom(clamped);
  }, [canvasWidth, canvasHeight]);

  const zoomIn = useCallback(() => {
    setCanvasZoom((canvasRef.current?.getZoom() ?? 1) * 1.2);
  }, [setCanvasZoom]);
  const zoomOut = useCallback(() => {
    setCanvasZoom((canvasRef.current?.getZoom() ?? 1) / 1.2);
  }, [setCanvasZoom]);
  const zoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    setZoom(1);
  }, []);

  const rotateBase = useCallback((deltaDeg: number) => {
    const img = baseImageRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    img.set({ angle: ((img.angle ?? 0) + deltaDeg) % 360 });
    img.setCoords();
    canvas.requestRenderAll();
  }, []);

  const refitBase = useCallback(
    (pct: number) => {
      const img = baseImageRef.current;
      const canvas = canvasRef.current;
      if (!img || !canvas) return;
      const base = initialBaseTransform(
        { width: canvasWidth, height: canvasHeight },
        { width: img.width ?? 1, height: img.height ?? 1 },
        pct,
      );
      // Mantém posição/ângulo do usuário; a margem só re-escala.
      img.set({ scaleX: base.scaleX, scaleY: base.scaleY });
      img.setCoords();
      canvas.requestRenderAll();
    },
    [canvasWidth, canvasHeight],
  );

  const resetBase = useCallback(
    (pct: number) => {
      const img = baseImageRef.current;
      const canvas = canvasRef.current;
      if (!img || !canvas) return;
      const base = initialBaseTransform(
        { width: canvasWidth, height: canvasHeight },
        { width: img.width ?? 1, height: img.height ?? 1 },
        pct,
      );
      img.set({
        left: base.left,
        top: base.top,
        scaleX: base.scaleX,
        scaleY: base.scaleY,
        angle: 0,
        flipX: false,
        flipY: false,
      });
      img.setCoords();
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      setZoom(1);
      canvas.requestRenderAll();
    },
    [canvasWidth, canvasHeight],
  );

  const readBaseTransform = useCallback((): EditRecipeBaseTransform | null => {
    const img = baseImageRef.current;
    if (!img) return null;
    return {
      left: img.left ?? 0,
      top: img.top ?? 0,
      scaleX: img.scaleX ?? 1,
      scaleY: img.scaleY ?? 1,
      angle: img.angle ?? 0,
      ...(img.flipX ? { flipX: true } : {}),
      ...(img.flipY ? { flipY: true } : {}),
    };
  }, []);

  const exportImage = useCallback(
    (format: "png" | "jpeg", quality = 0.9): string | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      // O export ignora o zoom de VISUALIZAÇÃO: reseta o viewport, exporta o
      // canvas lógico inteiro em multiplier 1 e restaura.
      const vpt = canvas.viewportTransform
        ? ([...canvas.viewportTransform] as typeof canvas.viewportTransform)
        : null;
      canvas.discardActiveObject();
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      try {
        return canvas.toDataURL({
          format,
          quality,
          multiplier: 1,
          left: 0,
          top: 0,
          width: canvasWidth,
          height: canvasHeight,
        });
      } catch (err) {
        // Canvas tainted (CORS do /uploads) é o suspeito nº 1.
        console.error("[image-editor] export falhou:", err);
        onErrorRef.current?.(
          "Não foi possível exportar a imagem (falha de segurança do navegador). Recarregue e tente de novo.",
        );
        return null;
      } finally {
        if (vpt) canvas.setViewportTransform(vpt);
        canvas.requestRenderAll();
      }
    },
    [canvasWidth, canvasHeight],
  );

  return {
    canvasElRef,
    wrapperRef,
    ready,
    zoom,
    zoomIn,
    zoomOut,
    zoomToFit,
    rotateBase,
    refitBase,
    resetBase,
    readBaseTransform,
    exportImage,
  };
}
