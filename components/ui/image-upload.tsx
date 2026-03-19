"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, X, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";

interface ImageUploadProps {
  value?: string;
  onChange: (url: string) => void;
  onError?: (error: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ImageUpload({
  value,
  onChange,
  onError,
  disabled = false,
  className = "",
}: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(
    value && value.trim() !== "" ? value : null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sincronizar preview com valor das props
  useEffect(() => {
    setPreview(value && value.trim() !== "" ? value : null);
  }, [value]);

  const handleFileSelect = useCallback(
    async (file: File) => {
      // Validações básicas
      if (!file.type.startsWith("image/")) {
        onError?.("Apenas arquivos de imagem são permitidos");
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        onError?.("O arquivo deve ter no máximo 5MB");
        return;
      }

      setIsUploading(true);

      try {
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
        const imageUrl: string = result.imageUrl;

        // Preview e valor usam localhost (mantendo compatibilidade com ambiente local)
        setPreview(imageUrl);
        onChange(imageUrl);
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
    [onChange, onError],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        handleFileSelect(files[0]);
      }
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        handleFileSelect(files[0]);
      }
    },
    [handleFileSelect],
  );

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleRemove = useCallback(() => {
    setPreview(null);
    onChange("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [onChange]);

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Área de upload */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={handleClick}
        className={`
          relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer
          transition-colors hover:bg-muted/50
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}
          ${preview ? "border-primary" : "border-muted-foreground/25"}
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileInputChange}
          disabled={disabled || isUploading}
          className="hidden"
        />

        {preview ? (
          <div className="space-y-4">
            <div className="relative inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview}
                alt="Preview da imagem"
                className="rounded-lg object-cover max-w-full max-h-48"
                style={{ width: "200px", height: "200px" }}
                onLoad={() => console.log("Imagem carregada com sucesso")}
                onError={(e) => {
                  console.error("Erro ao carregar imagem:", preview);
                  const target = e.currentTarget as HTMLImageElement;
                  target.style.display = "none";
                  const parent = target.parentElement;
                  if (parent && typeof document !== 'undefined' && !parent.querySelector(".error-placeholder")) {
                    const errorDiv = document.createElement("div");
                    errorDiv.className =
                      "error-placeholder w-[200px] h-[200px] rounded-lg bg-red-50 border border-red-200 flex items-center justify-center text-red-600 text-sm";
                    errorDiv.textContent = "Erro ao carregar imagem";
                    parent.appendChild(errorDiv);
                  }
                }}
              />
              {!disabled && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="absolute -top-2 -right-2 h-6 w-6 rounded-full p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove();
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Clique para alterar a imagem
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {isUploading ? (
              <div className="flex flex-col items-center space-y-2">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                <p className="text-sm text-muted-foreground">
                  Enviando imagem...
                </p>
              </div>
            ) : (
              <>
                <ImageIcon className="mx-auto h-12 w-12 text-muted-foreground" />
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    Clique para selecionar ou arraste uma imagem
                  </p>
                  <p className="text-xs text-muted-foreground">
                    JPEG, PNG ou WebP até 5MB
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Botões de ação */}
      {!disabled && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClick}
            disabled={isUploading}
          >
            <Upload className="h-4 w-4 mr-2" />
            {preview ? "Alterar" : "Selecionar"} Imagem
          </Button>
          {preview && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRemove}
              disabled={isUploading}
            >
              <X className="h-4 w-4 mr-2" />
              Remover
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
