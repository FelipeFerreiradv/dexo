"use client";

import { useCallback, useRef, useState } from "react";
import { GripVertical, Image as ImageIcon, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getApiBaseUrl } from "@/lib/api";
import { useRemoveBackgroundToggle } from "@/hooks/use-remove-background-toggle";

interface MultiImageUploadProps {
  value: string[];
  onChange: (urls: string[]) => void;
  onError?: (error: string) => void;
  /** Avisos não-bloqueantes do backend (ex.: fallback do sidecar). */
  onWarning?: (warning: string) => void;
  disabled?: boolean;
  className?: string;
  maxImages?: number;
}

export function MultiImageUpload({
  value = [],
  onChange,
  onError,
  onWarning,
  disabled = false,
  className = "",
  maxImages = 10,
}: MultiImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [removeBackground, setRemoveBackground] = useRemoveBackgroundToggle(true);

  const uploadFile = useCallback(
    async (
      file: File,
    ): Promise<{ url: string | null; warning?: string }> => {
      if (!file.type.startsWith("image/")) {
        onError?.("Apenas arquivos de imagem são permitidos");
        return { url: null };
      }
      if (file.size > 5 * 1024 * 1024) {
        onError?.("O arquivo deve ter no máximo 5MB");
        return { url: null };
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("removeBackground", removeBackground ? "true" : "false");

      const response = await fetch(`${getApiBaseUrl()}/upload/image`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || "Erro ao fazer upload");
      }

      const result = (await response.json()) as {
        imageUrl: string;
        warning?: string;
      };
      return { url: result.imageUrl, warning: result.warning };
    },
    [onError, removeBackground],
  );

  const handleFilesSelect = useCallback(
    async (files: File[]) => {
      const remaining = maxImages - value.length;
      if (remaining <= 0) {
        onError?.(`Máximo de ${maxImages} imagens permitido`);
        return;
      }

      const filesToUpload = files.slice(0, remaining);
      setIsUploading(true);

      try {
        const settled = await Promise.allSettled(
          filesToUpload.map((file) => uploadFile(file)),
        );
        const fulfilled = settled.filter(
          (r): r is PromiseFulfilledResult<{ url: string | null; warning?: string }> =>
            r.status === "fulfilled",
        );
        const urls = fulfilled
          .map((r) => r.value.url)
          .filter((url): url is string => url !== null);
        if (urls.length > 0) {
          onChange([...value, ...urls]);
        }

        // Dedup warnings: se múltiplas imagens caíram no mesmo fallback,
        // mostra uma mensagem só.
        const warnings = Array.from(
          new Set(
            fulfilled
              .map((r) => r.value.warning)
              .filter((w): w is string => Boolean(w)),
          ),
        );
        for (const w of warnings) onWarning?.(w);

        const failed = settled.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
          onError?.(`${failed.length} imagem(ns) falharam no upload`);
        }
      } catch (error) {
        console.error("Erro no upload:", error);
        onError?.(
          error instanceof Error
            ? error.message
            : "Erro ao fazer upload da imagem",
        );
      } finally {
        setIsUploading(false);
      }
    },
    [value, onChange, onError, onWarning, maxImages, uploadFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) handleFilesSelect(files);
    },
    [handleFilesSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        handleFilesSelect(Array.from(files));
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [handleFilesSelect],
  );

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleRemove = useCallback(
    (index: number) => {
      const updated = value.filter((_, i) => i !== index);
      onChange(updated);
    },
    [value, onChange],
  );

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index === 0) return;
      const updated = [...value];
      [updated[index - 1], updated[index]] = [
        updated[index],
        updated[index - 1],
      ];
      onChange(updated);
    },
    [value, onChange],
  );

  const hasImages = value.length > 0;

  return (
    <div className={`space-y-4 ${className}`}>
      <RemoveBackgroundToggle
        value={removeBackground}
        onValueChange={setRemoveBackground}
        disabled={disabled || isUploading}
        hasImages={hasImages}
      />

      {/* Imagens já enviadas */}
      {hasImages && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {value.map((url, index) => (
            <div
              key={`${url}-${index}`}
              className="group relative rounded-lg border bg-muted/30 overflow-hidden"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`Imagem ${index + 1}`}
                className="aspect-square w-full object-cover"
              />
              {index === 0 && (
                <span className="absolute top-1 left-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  Principal
                </span>
              )}
              {!disabled && (
                <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => handleMoveUp(index)}
                      title="Mover para frente"
                    >
                      <GripVertical className="h-3 w-3" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => handleRemove(index)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Área de upload */}
      {value.length < maxImages && (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={handleClick}
          className={`
            relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer
            transition-colors hover:bg-muted/50
            ${disabled ? "opacity-50 cursor-not-allowed" : ""}
            border-muted-foreground/25
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInputChange}
            disabled={disabled || isUploading}
            className="hidden"
          />

          {isUploading ? (
            <div className="flex flex-col items-center space-y-2">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              <p className="text-sm text-muted-foreground">
                {removeBackground
                  ? "Removendo fundo e otimizando..."
                  : "Otimizando imagens..."}
              </p>
            </div>
          ) : (
            <>
              <ImageIcon className="mx-auto h-10 w-10 text-muted-foreground" />
              <div className="mt-2 space-y-1">
                <p className="text-sm font-medium">
                  {value.length === 0
                    ? "Clique para selecionar ou arraste imagens"
                    : "Adicionar mais imagens"}
                </p>
                <p className="text-xs text-muted-foreground">
                  JPEG, PNG ou WebP até 5MB • Máx. {maxImages} imagens (
                  {maxImages - value.length} restantes)
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Botões de ação */}
      {!disabled && hasImages && (
        <div className="flex gap-2">
          {value.length < maxImages && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleClick}
              disabled={isUploading}
            >
              <Upload className="h-4 w-4 mr-2" />
              Adicionar Imagem
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function RemoveBackgroundToggle({
  value,
  onValueChange,
  disabled,
  hasImages,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled: boolean;
  hasImages: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <Label
          htmlFor="multi-image-upload-remove-bg"
          className="cursor-pointer text-sm font-medium"
        >
          Remover fundo automaticamente
        </Label>
        <p className="text-xs text-muted-foreground">
          {hasImages
            ? "Aplica-se a novas imagens — as atuais não são reprocessadas."
            : "Recomendado para fotos de produtos com fundo branco/contextual."}
        </p>
      </div>
      <Switch
        id="multi-image-upload-remove-bg"
        checked={value}
        onCheckedChange={onValueChange}
        disabled={disabled}
      />
    </div>
  );
}
