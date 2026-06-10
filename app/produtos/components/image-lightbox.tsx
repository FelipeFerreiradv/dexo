"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";

interface ImageLightboxProps {
  images: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialIndex?: number;
  alt?: string;
}

/**
 * Lightbox reusável: abre uma imagem em foco (Dialog modal escuro),
 * com navegação prev/next entre múltiplas imagens, contador, atalhos
 * de teclado (←/→/Esc) e fechamento por clique fora.
 */
export function ImageLightbox({
  images,
  open,
  onOpenChange,
  initialIndex = 0,
  alt,
}: ImageLightboxProps) {
  const [index, setIndex] = useState(initialIndex);

  // Reseta o índice quando o lightbox é aberto ou quando initialIndex muda
  useEffect(() => {
    if (open) setIndex(Math.min(initialIndex, Math.max(0, images.length - 1)));
  }, [open, initialIndex, images.length]);

  // Prefetch das imagens vizinhas (próxima e anterior) para navegação instantânea.
  // Usa new Image() para baixar em background e popular o cache do navegador,
  // sem renderizar nada extra no DOM.
  useEffect(() => {
    if (!open || images.length <= 1) return;
    const neighbors = new Set([
      (index + 1) % images.length,
      (index - 1 + images.length) % images.length,
    ]);
    neighbors.delete(index);
    neighbors.forEach((i) => {
      const url = images[i];
      if (!url) return;
      const img = new window.Image();
      img.decoding = "async";
      img.src = url;
    });
  }, [open, index, images]);

  if (images.length === 0) return null;

  const currentUrl = images[index] ?? null;
  const showNav = images.length > 1;

  const goPrev = () => setIndex((index - 1 + images.length) % images.length);
  const goNext = () => setIndex((index + 1) % images.length);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/85 backdrop-blur-sm" />
        <DialogPrimitive.Content
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              goPrev();
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              goNext();
            }
          }}
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 w-[95vw] max-w-6xl translate-x-[-50%] translate-y-[-50%] outline-none"
        >
          <DialogTitle className="sr-only">
            {alt
              ? `Imagem ${index + 1} de ${images.length} — ${alt}`
              : `Imagem ${index + 1} de ${images.length}`}
          </DialogTitle>

          {/* Contador */}
          {images.length > 1 ? (
            <div className="absolute left-4 top-4 z-10 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white backdrop-blur">
              {index + 1} / {images.length}
            </div>
          ) : null}

          {/* Botão fechar */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title="Fechar (Esc)"
            className="absolute right-4 top-4 z-10 flex size-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition-colors hover:bg-black/80"
          >
            <X className="size-4" />
          </button>

          {/* Imagem principal */}
          <div className="flex h-[85vh] items-center justify-center">
            {currentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentUrl}
                alt={alt ?? "Imagem em foco"}
                decoding="async"
                className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
              />
            ) : null}
          </div>

          {/* Botões navegação */}
          {showNav ? (
            <>
              <button
                type="button"
                onClick={goPrev}
                title="Imagem anterior (←)"
                className="absolute left-4 top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition-colors hover:bg-black/80"
              >
                <ChevronLeft className="size-5" />
              </button>
              <button
                type="button"
                onClick={goNext}
                title="Próxima imagem (→)"
                className="absolute right-4 top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition-colors hover:bg-black/80"
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
