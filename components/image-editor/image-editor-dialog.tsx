"use client";

/**
 * ImageEditorDialog — Editor de Imagem, base (PR 6).
 *
 * Aberto pelo botão "Editar" do multi-image-upload (dynamic import — o chunk
 * do fabric ~90KB gz só carrega ao abrir). Segue o precedente do
 * image-lightbox: DialogPrimitive.Content cru + DialogTitle sr-only.
 *
 * Escopo do PR 6: preset de tela, fundo, margem, mover/escalar/rotacionar a
 * peça (controles do fabric + pinch/pan próprios), export na resolução final
 * e SAVE não-destrutivo (arquivo novo + receita em ProductImageEdit).
 * Anotações (texto/seta/elipse) chegam no PR 7; apagar/restaurar no PR 8.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Loader2,
  Maximize2,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  classifyUploadError,
  fetchImageEditMeta,
  uploadEditedImage,
} from "@/lib/upload-image";

import {
  DEFAULT_PADDING_PCT,
  DEFAULT_PRESET_ID,
  EDITOR_PRESETS,
  type EditorBackground,
  presetExportSize,
  resolvePreset,
} from "./presets";
import { buildRecipeV1, isEditRecipeV1 } from "./recipe";
import { useFabricEditor } from "./use-fabric-editor";

export interface ImageEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** URL da imagem a editar (a que está no formulário). */
  imageUrl: string | null;
  /** Chamado com a URL NOVA salva — o chamador substitui na posição. */
  onSaved: (newUrl: string) => void;
  onError?: (message: string) => void;
}

function basenameOf(url: string): string {
  const clean = url.split("?")[0];
  return clean.substring(clean.lastIndexOf("/") + 1);
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export default function ImageEditorDialog({
  open,
  onOpenChange,
  imageUrl,
  onSaved,
  onError,
}: ImageEditorDialogProps) {
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [background, setBackground] = useState<EditorBackground>({
    mode: "white",
  });
  const [paddingPct, setPaddingPct] = useState(DEFAULT_PADDING_PCT);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  // Fonte REAL da edição: se a imagem veio de um save anterior, editamos a
  // partir da fonte da receita (não do bitmap achatado).
  const [source, setSource] = useState<{
    url: string;
    fileName: string;
    cutoutFileName?: string;
  } | null>(null);
  const [sourceSize, setSourceSize] = useState<{
    width: number;
    height: number;
  }>({ width: 1200, height: 1200 });
  const [initialBase, setInitialBase] = useState<
    ReturnType<typeof Object> | null
  >(null);

  // Resolve a fonte quando abre: meta do backend (receita de save anterior)
  // ou a própria URL exibida.
  useEffect(() => {
    if (!open || !imageUrl) return;
    let cancelled = false;
    const fileName = basenameOf(imageUrl);
    setDirty(false);
    setSource(null);
    setInitialBase(null);
    fetchImageEditMeta(fileName)
      .catch(() => null)
      .then((meta) => {
        if (cancelled) return;
        if (meta?.edit && isEditRecipeV1(meta.edit.recipe)) {
          const r = meta.edit.recipe;
          setPresetId(r.presetId);
          setBackground(r.background);
          setPaddingPct(r.paddingPct);
          setInitialBase(r.base as never);
          setSourceSize({
            width: r.source.width || 1200,
            height: r.source.height || 1200,
          });
          setSource({
            url: meta.edit.sourceUrl,
            fileName: meta.edit.sourceFileName,
            cutoutFileName: meta.edit.cutoutFileName,
          });
        } else {
          setPresetId(DEFAULT_PRESET_ID);
          setBackground({ mode: "white" });
          setPaddingPct(DEFAULT_PADDING_PCT);
          setSource({
            url: imageUrl,
            fileName,
            // PNG do pipeline = recorte: registra para o restore do PR 8.
            ...(fileName.toLowerCase().endsWith(".png")
              ? { cutoutFileName: fileName }
              : {}),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, imageUrl]);

  const preset = resolvePreset(presetId);
  const exportSize = useMemo(
    () => presetExportSize(preset, sourceSize),
    [preset, sourceSize],
  );

  const markDirty = useCallback(() => setDirty(true), []);

  const editor = useFabricEditor({
    imageUrl: open ? (source?.url ?? null) : null,
    canvasWidth: exportSize.width,
    canvasHeight: exportSize.height,
    background,
    paddingPct,
    initialBase: initialBase as never,
    onError,
    // Dimensões REAIS medidas no load: sem isto o preset "Original" exportava
    // 1200×1200 e a receita persistia source.width/height falsos (BLOCKER da
    // revisão). O initialBase (receita reaberta) é consumido UMA vez — trocar
    // de preset depois re-fita em vez de reaplicar o transform antigo.
    onImageLoaded: (size) => {
      setSourceSize((prev) =>
        prev.width === size.width && prev.height === size.height ? prev : size,
      );
      setInitialBase(null);
    },
    // Dirty REAL de manipulação da peça (transform concluído nos controles).
    onBaseModified: markDirty,
  });

  const requestClose = useCallback(
    (next: boolean) => {
      if (!next && dirty && !saving) {
        setConfirmClose(true);
        return;
      }
      onOpenChange(next);
    },
    [dirty, saving, onOpenChange],
  );

  const handleSave = useCallback(async () => {
    if (!source) return;
    const base = editor.readBaseTransform();
    if (!base) return;
    // Fundo transparente => PNG; opaco => JPEG q0.9 (menor, padrão de anúncio).
    const format = background.mode === "transparent" ? "png" : "jpeg";
    const dataUrl = editor.exportImage(format, 0.9);
    if (!dataUrl) return;
    setSaving(true);
    try {
      const blob = await dataUrlToBlob(dataUrl);
      const recipe = buildRecipeV1({
        presetId,
        canvas: exportSize,
        source: {
          fileName: source.fileName,
          width: sourceSize.width,
          height: sourceSize.height,
        },
        cutoutFileName: source.cutoutFileName,
        background,
        paddingPct,
        base,
      });
      const saved = await uploadEditedImage({
        blob,
        recipe,
        sourceFileName: source.fileName,
        cutoutFileName: source.cutoutFileName,
      });
      onSaved(saved.url);
      setDirty(false);
      onOpenChange(false);
    } catch (err) {
      onError?.(classifyUploadError(err).message);
    } finally {
      setSaving(false);
    }
  }, [
    source,
    editor,
    background,
    presetId,
    exportSize,
    sourceSize,
    paddingPct,
    onSaved,
    onOpenChange,
    onError,
  ]);

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogPortal>
          <DialogOverlay className="bg-black/80 backdrop-blur-sm" />
          <DialogPrimitive.Content
            onInteractOutside={(e) => e.preventDefault()}
            className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed top-[50%] left-[50%] z-50 flex max-h-[95vh] w-[96vw] max-w-5xl translate-x-[-50%] translate-y-[-50%] flex-col gap-3 rounded-lg border bg-background p-4 shadow-2xl outline-none"
          >
            <DialogTitle className="sr-only">Editar imagem</DialogTitle>

            {/* Canvas */}
            <div
              ref={editor.wrapperRef}
              className="relative flex min-h-[280px] flex-1 items-center justify-center overflow-hidden rounded-md border bg-[repeating-conic-gradient(#e5e5e5_0%_25%,#fafafa_0%_50%)] bg-[length:16px_16px]"
              style={{ touchAction: "none" }}
            >
              <canvas ref={editor.canvasElRef} />
              {!editor.ready && !editor.loadError && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}
              {editor.loadError && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-center text-sm text-muted-foreground">
                  Não foi possível carregar a imagem. Feche e tente de novo.
                </div>
              )}
            </div>

            {/* Toolbar — embaixo (polegar no celular) */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex items-center gap-2">
                <Label className="text-xs whitespace-nowrap">Tamanho</Label>
                <Select
                  value={presetId}
                  onValueChange={(v) => {
                    setPresetId(v);
                    markDirty();
                  }}
                >
                  <SelectTrigger className="h-8 w-[200px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EDITOR_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-1.5">
                <Label className="text-xs">Fundo</Label>
                {(
                  [
                    ["white", "Branco"],
                    ["transparent", "Transparente"],
                    ["color", "Cor"],
                  ] as const
                ).map(([mode, label]) => (
                  <Button
                    key={mode}
                    type="button"
                    size="sm"
                    variant={background.mode === mode ? "default" : "outline"}
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setBackground((prev) => ({
                        mode,
                        color:
                          mode === "color" ? (prev.color ?? "#f5f5f5") : undefined,
                      }));
                      markDirty();
                    }}
                  >
                    {label}
                  </Button>
                ))}
                {background.mode === "color" && (
                  <input
                    type="color"
                    aria-label="Cor do fundo"
                    value={background.color ?? "#f5f5f5"}
                    onChange={(e) => {
                      setBackground({ mode: "color", color: e.target.value });
                      markDirty();
                    }}
                    className="h-7 w-9 cursor-pointer rounded border bg-transparent p-0.5"
                  />
                )}
              </div>

              <div className="flex min-w-[160px] flex-1 items-center gap-2">
                <Label className="text-xs whitespace-nowrap">
                  Margem ({paddingPct}%)
                </Label>
                <Slider
                  value={[paddingPct]}
                  min={40}
                  max={100}
                  step={1}
                  className="max-w-[180px]"
                  onValueChange={([v]) => {
                    setPaddingPct(v);
                    editor.refitBase(v);
                    markDirty();
                  }}
                />
              </div>

              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  title="Girar 90° anti-horário"
                  onClick={() => {
                    editor.rotateBase(-90);
                    markDirty();
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  title="Girar 90° horário"
                  onClick={() => {
                    editor.rotateBase(90);
                    markDirty();
                  }}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  title="Diminuir zoom"
                  onClick={editor.zoomOut}
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
                <span className="w-10 text-center text-[10px] tabular-nums text-muted-foreground">
                  {Math.round(editor.zoom * 100)}%
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  title="Aumentar zoom"
                  onClick={editor.zoomIn}
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  title="Ajustar à tela"
                  onClick={editor.zoomToFit}
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  title="Voltar ao enquadramento inicial"
                  onClick={() => editor.resetBase(paddingPct)}
                >
                  Resetar
                </Button>
              </div>

              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => requestClose(false)}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || !editor.ready}
                  onClick={() => void handleSave()}
                >
                  {saving ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Salvar imagem
                </Button>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>

      {/* Confirmação ao fechar com edição não salva */}
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar edição?</AlertDialogTitle>
            <AlertDialogDescription>
              Você tem alterações não salvas. Fechar agora descarta tudo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuar editando</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmClose(false);
                onOpenChange(false);
              }}
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
