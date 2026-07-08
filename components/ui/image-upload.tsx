"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getApiBaseUrl } from "@/lib/api";
import { useRemoveBackgroundToggle } from "@/hooks/use-remove-background-toggle";
import { useAddShadowToggle } from "@/hooks/use-add-shadow-toggle";

interface ImageUploadProps {
  value?: string;
  onChange: (url: string) => void;
  onError?: (error: string) => void;
  /** Chamado quando o backend processa mas avisa algo (ex.: fallback). */
  onWarning?: (warning: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ImageUpload({
  value,
  onChange,
  onError,
  onWarning,
  disabled = false,
  className = "",
}: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(
    value && value.trim() !== "" ? value : null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [removeBackground, setRemoveBackground] = useRemoveBackgroundToggle(true);
  const [addShadow, setAddShadow] = useAddShadowToggle(true);

  useEffect(() => {
    setPreview(value && value.trim() !== "" ? value : null);
  }, [value]);

  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        onError?.("Apenas arquivos de imagem são permitidos");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        onError?.("O arquivo deve ter no máximo 20MB");
        return;
      }

      setIsUploading(true);

      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("removeBackground", removeBackground ? "true" : "false");
        // Sombra exige o recorte: só pede sombra se a remoção de fundo está ON.
        formData.append(
          "addShadow",
          removeBackground && addShadow ? "true" : "false",
        );

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
        if (result.warning) {
          onWarning?.(result.warning);
        }
        setPreview(result.imageUrl);
        onChange(result.imageUrl);
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
    [onChange, onError, onWarning, removeBackground, addShadow],
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
    <div className={`space-y-3 ${className}`}>
      <RemoveBackgroundToggle
        value={removeBackground}
        onValueChange={setRemoveBackground}
        disabled={disabled || isUploading}
        hasPreview={Boolean(preview)}
      />

      <ContactShadowToggle
        value={addShadow}
        onValueChange={setAddShadow}
        disabled={disabled || isUploading || !removeBackground}
        removeBackgroundOff={!removeBackground}
      />

      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={handleClick}
        className={`
          relative cursor-pointer rounded-lg border-2 border-dashed p-6 text-center
          transition-colors hover:bg-muted/50
          ${disabled ? "cursor-not-allowed opacity-50" : ""}
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
                className="max-h-48 max-w-full rounded-lg object-cover"
                style={{ width: "200px", height: "200px" }}
                onError={(e) => {
                  console.error("Erro ao carregar imagem:", preview);
                  const target = e.currentTarget as HTMLImageElement;
                  target.style.display = "none";
                  const parent = target.parentElement;
                  if (
                    parent &&
                    typeof document !== "undefined" &&
                    !parent.querySelector(".error-placeholder")
                  ) {
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
                  className="absolute -right-2 -top-2 h-6 w-6 rounded-full p-0"
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
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary"></div>
                <p className="text-sm text-muted-foreground">
                  {!removeBackground
                    ? "Otimizando imagem..."
                    : addShadow
                      ? "Removendo fundo, adicionando sombra e otimizando..."
                      : "Removendo fundo e otimizando..."}
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
                    JPEG, PNG ou WebP até 20MB
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {!disabled && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClick}
            disabled={isUploading}
          >
            <Upload className="mr-2 h-4 w-4" />
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
              <X className="mr-2 h-4 w-4" />
              Remover
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Toggle compartilhado de "Remover fundo automaticamente". Mostra um
 * hint quando já há imagem carregada esclarecendo que a troca só vale
 * pra próximos uploads (não reprocessa retroativamente).
 */
function RemoveBackgroundToggle({
  value,
  onValueChange,
  disabled,
  hasPreview,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled: boolean;
  hasPreview: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <Label
          htmlFor="image-upload-remove-bg"
          className="cursor-pointer text-sm font-medium"
        >
          Remover fundo automaticamente
        </Label>
        <p className="text-xs text-muted-foreground">
          {hasPreview
            ? "Aplica-se a novas imagens — a atual não é reprocessada."
            : "Recomendado para fotos de produtos com fundo branco/contextual."}
        </p>
      </div>
      <Switch
        id="image-upload-remove-bg"
        checked={value}
        onCheckedChange={onValueChange}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Toggle de "Adicionar sombra automaticamente". Espelha o de fundo, mas
 * exige o recorte: fica desabilitado (e desligado visualmente) quando
 * "remover fundo" está OFF — a sombra é derivada do alpha do recorte.
 */
function ContactShadowToggle({
  value,
  onValueChange,
  disabled,
  removeBackgroundOff,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled: boolean;
  removeBackgroundOff: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <Label
          htmlFor="image-upload-add-shadow"
          className="cursor-pointer text-sm font-medium"
        >
          Adicionar sombra automaticamente
        </Label>
        <p className="text-xs text-muted-foreground">
          {removeBackgroundOff
            ? "Requer “Remover fundo” ligado — a sombra usa o recorte."
            : "Sombra de contato suave sob a peça, com aspecto profissional."}
        </p>
      </div>
      <Switch
        id="image-upload-add-shadow"
        checked={value && !removeBackgroundOff}
        onCheckedChange={onValueChange}
        disabled={disabled}
      />
    </div>
  );
}
