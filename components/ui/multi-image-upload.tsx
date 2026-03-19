"use client";

import { useState, useRef, useCallback } from "react";
import { Upload, X, Image as ImageIcon, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";

interface MultiImageUploadProps {
  value: string[];
  onChange: (urls: string[]) => void;
  onError?: (error: string) => void;
  disabled?: boolean;
  className?: string;
  maxImages?: number;
}

export function MultiImageUpload({
  value = [],
  onChange,
  onError,
  disabled = false,
  className = "",
  maxImages = 10,
}: MultiImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (!file.type.startsWith("image/")) {
        onError?.("Apenas arquivos de imagem são permitidos");
        return null;
      }
      if (file.size > 5 * 1024 * 1024) {
        onError?.("O arquivo deve ter no máximo 5MB");
        return null;
      }

      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${getApiBaseUrl()}/upload/image`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Erro ao fazer upload");
      }

      const result = await response.json();
      return result.imageUrl as string;
    },
    [onError],
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
        const results = settled
          .filter(
            (r): r is PromiseFulfilledResult<string | null> =>
              r.status === "fulfilled",
          )
          .map((r) => r.value)
          .filter((url): url is string => url !== null);
        if (results.length > 0) {
          onChange([...value, ...results]);
        }
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
    [value, onChange, onError, maxImages, uploadFile],
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
      // Reset input so the same file can be selected again
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

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Imagens já enviadas */}
      {value.length > 0 && (
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
            ${value.length > 0 ? "border-muted-foreground/25" : "border-muted-foreground/25"}
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
                Enviando imagem...
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
      {!disabled && value.length > 0 && (
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
