"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GripVertical,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  classifyUploadError,
  uploadProductImage,
  validateImageFile,
  type UploadBgJobRef,
} from "@/lib/upload-image";
import {
  isImageBgJobTerminal,
  retryImageBgJob,
  type ImageBgJobStatus,
} from "@/lib/image-bg-jobs";
import { useImageBgJobs } from "@/hooks/use-image-bg-jobs";
import { useRemoveBackgroundToggle } from "@/hooks/use-remove-background-toggle";
import { useAddShadowToggle } from "@/hooks/use-add-shadow-toggle";

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

// Concorrência do upload em lote. Casada com a capacidade do gate do sidecar
// no backend (`REMBG_MAX_CONCURRENCY`, default 2).
//
// Por que 2 e não 3: o sidecar serializa (1 worker, inferência CPU-bound), então
// o wall-clock do LOTE é `N·T` para qualquer concorrência >= 2 — baixar de 3
// para 2 não custa tempo nenhum. O que muda é a PIOR espera de uma requisição
// isolada: cai de ~3T para ~2T (de ~29s para ~20s a T=9s). Isso importa porque
// quem estoura o orçamento perde o recorte e volta como WebP sem fundo removido.
// Ou seja: 2 faz MAIS imagens saírem com recorte, não menos.
// Não subir de volta para 3 sem subir o gate junto.
const UPLOAD_CONCURRENCY = 2;

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner()),
  );
  return results;
}

/** Estado local de um recorte assíncrono em andamento, chaveado pela URL
 *  provisória (WebP) que está no `value`. */
interface BgJobState {
  jobId: string;
  status: string;
  startedAt: number;
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
  const [addShadow, setAddShadow] = useAddShadowToggle(true);

  // --- Recorte assíncrono (PR 4) ------------------------------------------
  // O `value` continua sendo `string[]` puro (API intocada para os 4
  // consumidores); o estado por-thumbnail vive só aqui. Quando o job conclui,
  // trocamos a WebP provisória pelo PNG NA MESMA POSIÇÃO (preserva a ordem e
  // o "Principal") — o setValue("imageUrl", urls[0]) dos consumidores reage.
  const [bgJobs, setBgJobs] = useState<Record<string, BgJobState>>({});
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Re-render periódico só para a mensagem ">60s" do overlay evoluir.
  const hasActiveBgJobs = Object.values(bgJobs).some(
    (j) => !isImageBgJobTerminal(j.status),
  );
  const [, setBgPulse] = useState(0);
  useEffect(() => {
    if (!hasActiveBgJobs) return;
    const id = setInterval(() => setBgPulse((p) => p + 1), 15_000);
    return () => clearInterval(id);
  }, [hasActiveBgJobs]);

  const handleJobsUpdate = useCallback((jobs: ImageBgJobStatus[]) => {
    for (const job of jobs) {
      if (job.status === "COMPLETED" && job.resultUrl) {
        const current = valueRef.current;
        if (current.includes(job.webpUrl)) {
          onChangeRef.current(
            current.map((u) => (u === job.webpUrl ? job.resultUrl! : u)),
          );
        }
        setBgJobs((prev) => {
          if (!prev[job.webpUrl]) return prev;
          const next = { ...prev };
          delete next[job.webpUrl];
          return next;
        });
      } else {
        setBgJobs((prev) => {
          const entry = prev[job.webpUrl];
          if (!entry || entry.status === job.status) return prev;
          return { ...prev, [job.webpUrl]: { ...entry, status: job.status } };
        });
      }
    }
  }, []);

  const activeJobIds = Object.values(bgJobs)
    .filter((j) => !isImageBgJobTerminal(j.status))
    .map((j) => j.jobId);
  useImageBgJobs(activeJobIds, handleJobsUpdate);

  const handleRetryBgJob = useCallback(
    async (jobId: string, url: string) => {
      const ok = await retryImageBgJob(jobId).catch(() => false);
      if (ok) {
        setBgJobs((prev) =>
          prev[url]
            ? {
                ...prev,
                [url]: { ...prev[url], status: "PENDING", startedAt: Date.now() },
              }
            : prev,
        );
      } else {
        onError?.("Não foi possível reprocessar o recorte. Tente de novo.");
      }
    },
    [onError],
  );

  const uploadFile = useCallback(
    async (
      file: File,
    ): Promise<{ url: string | null; warning?: string; bgJob?: UploadBgJobRef }> => {
      // Arquivo inválido avisa e NÃO conta como falha de upload (igual a antes).
      const invalid = validateImageFile(file);
      if (invalid) {
        onError?.(invalid);
        return { url: null };
      }

      const result = await uploadProductImage(file, {
        removeBackground,
        addShadow,
        // Opt-in do recorte assíncrono: só tem efeito se UPLOAD_ASYNC_REMBG
        // estiver ligado no servidor (duplo opt-in). Sem ele, o servidor
        // ignora o campo e responde como sempre.
        asyncBg: true,
      });
      return {
        url: result.url,
        warning: result.warning,
        bgJob: result.bgJob,
      };
    },
    [onError, removeBackground, addShadow],
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
        // Progressivo: cada imagem aparece assim que fica pronta (a 1ª em
        // ~7s, sem esperar o lote inteiro). Mantém a ordem de seleção via
        // `slots`, mesmo que terminem fora de ordem.
        const slots: (string | null)[] = new Array(filesToUpload.length).fill(
          null,
        );
        const settled = await runWithConcurrency(
          filesToUpload,
          UPLOAD_CONCURRENCY,
          async (file, index) => {
            const r = await uploadFile(file);
            if (r.url) {
              slots[index] = r.url;
              const done = slots.filter((u): u is string => u !== null);
              onChange([...value, ...done]);
              if (r.bgJob) {
                const url = r.url;
                const jobId = r.bgJob.jobId;
                setBgJobs((prev) => ({
                  ...prev,
                  [url]: { jobId, status: "PENDING", startedAt: Date.now() },
                }));
              }
            }
            return r;
          },
        );
        const fulfilled = settled.filter(
          (
            r,
          ): r is PromiseFulfilledResult<{
            url: string | null;
            warning?: string;
            bgJob?: UploadBgJobRef;
          }> => r.status === "fulfilled",
        );

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

        const failed = settled.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (failed.length > 0) {
          // Mostra o MOTIVO, não só a contagem. Antes, um 504 do nginx (que
          // chega como TypeError opaco por falta de CORS) virava um genérico
          // "falharam no upload" e o usuário não tinha o que fazer.
          const reasons = Array.from(
            new Set(failed.map((r) => classifyUploadError(r.reason).message)),
          );
          onError?.(
            reasons.length === 1
              ? failed.length === 1
                ? reasons[0]
                : `${failed.length} imagens falharam: ${reasons[0]}`
              : `${failed.length} imagem(ns) falharam no upload`,
          );
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
      // O input de arquivo já é bloqueado durante o upload (`disabled`), mas o
      // drop não era: arrastar um 2º lote no meio do 1º dobrava a concorrência
      // real e enchia a fila do sidecar. Avisa em vez de engolir os arquivos.
      if (isUploading) {
        onError?.(
          "Aguarde o upload atual terminar antes de adicionar mais imagens",
        );
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) handleFilesSelect(files);
    },
    [handleFilesSelect, isUploading, onError],
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
      const removedUrl = value[index];
      const updated = value.filter((_, i) => i !== index);
      // Se a imagem removida tinha recorte em andamento, para de acompanhar
      // (o job segue no servidor, mas a URL não está mais no formulário).
      setBgJobs((prev) => {
        if (!prev[removedUrl]) return prev;
        const next = { ...prev };
        delete next[removedUrl];
        return next;
      });
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

      <ContactShadowToggle
        value={addShadow}
        onValueChange={setAddShadow}
        disabled={disabled || isUploading || !removeBackground}
        removeBackgroundOff={!removeBackground}
      />

      {/* Imagens já enviadas */}
      {hasImages && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
              {(() => {
                const job = bgJobs[url];
                if (!job) return null;
                if (job.status === "FAILED") {
                  return (
                    <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-amber-500/90 px-1.5 py-1">
                      <span className="truncate text-[10px] font-medium text-white">
                        Recorte falhou
                      </span>
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="h-5 w-5 shrink-0"
                        title="Tentar recortar novamente"
                        onClick={() => void handleRetryBgJob(job.jobId, url)}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                }
                return (
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/85 px-1.5 py-1 backdrop-blur-[2px]">
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                    <span className="truncate text-[10px] text-muted-foreground">
                      {Date.now() - job.startedAt > 60_000
                        ? "Ainda recortando — pode salvar normalmente"
                        : "Recortando fundo…"}
                    </span>
                  </div>
                );
              })()}
              {index === 0 && (
                <span className="absolute top-1 left-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  Principal
                </span>
              )}
              {!disabled && (
                <div className="absolute top-1 right-1 flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
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
                {!removeBackground
                  ? "Otimizando imagens..."
                  : addShadow
                    ? "Removendo fundo, adicionando sombra e otimizando..."
                    : "Removendo fundo e otimizando..."}
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
                  JPEG, PNG ou WebP até 20MB • Máx. {maxImages} imagens (
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
          htmlFor="multi-image-upload-add-shadow"
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
        id="multi-image-upload-add-shadow"
        checked={value && !removeBackgroundOff}
        onCheckedChange={onValueChange}
        disabled={disabled}
      />
    </div>
  );
}
