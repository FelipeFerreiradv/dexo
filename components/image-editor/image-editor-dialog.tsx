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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  Loader2,
  Maximize2,
  Move,
  RotateCcw,
  RotateCw,
  Trash2,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { IText } from "fabric";

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
  deleteEditorAsset,
  type EditorAssetRef,
  fetchImageEditMeta,
  listEditorAssets,
  registerEditorAsset,
  uploadEditedImage,
  uploadProductImage,
  validateImageFile,
} from "@/lib/upload-image";

import {
  DEFAULT_PADDING_PCT,
  DEFAULT_PRESET_ID,
  EDITOR_PRESETS,
  type EditorBackground,
  presetExportSize,
  resolvePreset,
} from "./presets";
import {
  buildRecipeV1,
  isEditRecipeV1,
  shouldWarnMlAnnotations,
} from "./recipe";
import {
  ANNOTATION_PALETTE,
  addArrow,
  addEllipse,
  addImageLayer,
  addText,
  annotationLabel,
  applyShapeStroke,
  applyTextStyle,
  beginTextEditing,
  duplicateAnnotation,
  kindOf,
  listAnnotations,
  moveAnnotation,
  remapAnnotations,
  rememberTextareaHost,
  removeAnnotation,
  restoreAnnotations,
  serializeAnnotations,
  setBaseInteractive,
} from "./annotations";
import { EDITOR_FONTS, ensureEditorFontsLoaded } from "./fonts";
import { TEXTAREA_HOST_STYLE, clampScroll } from "./text-editing";
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
  // PR 7 — anotações: modo "move" (peça editável, comportamento do PR 6) vs
  // "annotate" (peça travada; textos/setas/círculos por cima).
  const [mode, setMode] = useState<"move" | "annotate">("move");
  // Re-render quando o canvas muda (seleção/adição/remoção) — os controles
  // de estilo e o painel de camadas leem o fabric direto no render.
  const [, setCanvasTick] = useState(0);
  // Camadas de uma receita reaberta, aplicadas UMA vez quando o canvas fica
  // pronto (restore parcial tolerante; não marca dirty).
  const pendingLayersRef = useRef<unknown[] | null>(null);
  // Host do <textarea> invisível de edição do IText. Fica DENTRO do Content
  // (logo, dentro do focus-trap do Radix, que é o motivo de não usar o <body>)
  // mas FORA do wrapper `overflow-hidden` do canvas — ver text-editing.ts.
  const textareaHostRef = useRef<HTMLDivElement>(null);
  // Biblioteca de veículos (padrão "peça + carro compatível"): carregada
  // LAZY na primeira abertura do painel — zero custo p/ quem não usa.
  const [vehiclePanelOpen, setVehiclePanelOpen] = useState(false);
  const [vehicleAssets, setVehicleAssets] = useState<EditorAssetRef[]>([]);
  const [vehicleAssetsLoaded, setVehicleAssetsLoaded] = useState(false);
  const [vehicleUploading, setVehicleUploading] = useState(false);
  const [vehicleRemoveBg, setVehicleRemoveBg] = useState(true);
  const vehicleInputRef = useRef<HTMLInputElement>(null);
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
    setMode("move");
    pendingLayersRef.current = null;
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
          pendingLayersRef.current = Array.isArray(r.layers) ? r.layers : null;
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

  /** URLs de /uploads derivadas da fonte atual (mesmo origin da API). */
  const resolveUploadUrl = useCallback(
    (fileName: string) => {
      const base = source?.url ?? imageUrl ?? "";
      const idx = base.lastIndexOf("/");
      return idx >= 0 ? `${base.slice(0, idx + 1)}${fileName}` : fileName;
    },
    [source, imageUrl],
  );
  // obj.set() do fabric NÃO emite evento — sem este bump os controles de
  // estilo/camadas congelam (setDirty(true) com dirty já true é bail-out).
  const bumpTick = useCallback(() => setCanvasTick((t) => t + 1), []);

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

  // Eventos do canvas → re-render (controles de estilo/painel de camadas
  // leem o fabric direto). `editor.ready` garante canvas vivo.
  useEffect(() => {
    const c = editor.getCanvas();
    if (!c || !editor.ready) return;
    const bump = () => setCanvasTick((t) => t + 1);
    const events = [
      "selection:created",
      "selection:updated",
      "selection:cleared",
      "object:added",
      "object:removed",
      "object:modified",
    ] as const;
    for (const ev of events) c.on(ev as never, bump as never);
    return () => {
      for (const ev of events) c.off(ev as never, bump as never);
    };
  }, [editor, editor.ready]);

  // Base travada fora do modo "Mover peça" — reaplicado também quando a
  // imagem recarrega (troca de preset re-adiciona a base destravada).
  useEffect(() => {
    const c = editor.getCanvas();
    if (!c || !editor.ready) return;
    setBaseInteractive(c, mode === "move");
  });

  // Restore das camadas de uma receita reaberta (uma vez, sem marcar dirty).
  useEffect(() => {
    const c = editor.getCanvas();
    if (!c || !editor.ready) return;
    // Registrado ANTES do early-return: caminhos internos que criam IText sem
    // receber o host (duplicar uma camada de texto) o resolvem pelo canvas.
    rememberTextareaHost(c, textareaHostRef.current);
    const pending = pendingLayersRef.current;
    if (!pending) return;
    pendingLayersRef.current = null;
    void restoreAnnotations(c, pending, {
      resolveUploadUrl,
      textareaHost: textareaHostRef.current,
    });
  }, [editor, editor.ready, resolveUploadUrl]);

  // Cinto e suspensório do salto de scroll: durante a edição, o fabric
  // reposiciona o textarea a cada movimento de cursor, e o navegador pode rolar
  // o wrapper `overflow-hidden` para trazer o elemento focado à vista — tirando
  // o canvas do enquadramento. Com o host acima isso não deve mais acontecer; a
  // guarda cobre diferença de comportamento entre navegadores. A condição é
  // lida DENTRO do handler (e não via assinatura de text:editing:entered/exited)
  // porque este efeito re-roda a cada render — `editor` troca de identidade — e
  // um listener montado por evento seria perdido no meio da edição.
  useEffect(() => {
    const c = editor.getCanvas();
    if (!c || !editor.ready) return;
    const wrapper = editor.wrapperRef.current;
    if (!wrapper) return;
    const onScroll = () => {
      const active = c.getActiveObject() as { isEditing?: boolean } | undefined;
      if (active?.isEditing) clampScroll(wrapper);
    };
    wrapper.addEventListener("scroll", onScroll);
    return () => wrapper.removeEventListener("scroll", onScroll);
  }, [editor, editor.ready]);

  const canvas = editor.ready ? editor.getCanvas() : null;
  const annotationObjects = canvas ? listAnnotations(canvas) : [];
  const activeObject = canvas?.getActiveObject() ?? null;
  const activeText =
    activeObject && kindOf(activeObject) === "text"
      ? (activeObject as IText)
      : null;
  const activeShape =
    activeObject &&
    (kindOf(activeObject) === "arrow" || kindOf(activeObject) === "ellipse")
      ? activeObject
      : null;

  const enterAnnotate = useCallback(() => setMode("annotate"), []);

  const handleAddText = useCallback(() => {
    const c = editor.getCanvas();
    if (!c) return;
    enterAnnotate();
    markDirty();
    void addText(c, undefined, textareaHostRef.current);
  }, [editor, enterAnnotate, markDirty]);

  const handleAddArrow = useCallback(() => {
    const c = editor.getCanvas();
    if (!c) return;
    enterAnnotate();
    markDirty();
    addArrow(c);
  }, [editor, enterAnnotate, markDirty]);

  const handleAddEllipse = useCallback(() => {
    const c = editor.getCanvas();
    if (!c) return;
    enterAnnotate();
    markDirty();
    addEllipse(c);
  }, [editor, enterAnnotate, markDirty]);


  const openVehiclePanel = useCallback(() => {
    setVehiclePanelOpen((prev) => !prev);
    if (!vehicleAssetsLoaded) {
      setVehicleAssetsLoaded(true);
      void listEditorAssets().then(setVehicleAssets);
    }
  }, [vehicleAssetsLoaded]);

  const handleInsertVehicle = useCallback(
    (asset: EditorAssetRef) => {
      const c = editor.getCanvas();
      if (!c) return;
      enterAnnotate();
      markDirty();
      setVehiclePanelOpen(false);
      void addImageLayer(c, asset.url, asset.fileName).catch(() =>
        onError?.("Não foi possível carregar o veículo. Tente novamente."),
      );
    },
    [editor, enterAnnotate, markDirty, onError],
  );

  const handleVehicleUpload = useCallback(
    async (file: File) => {
      const invalid = validateImageFile(file);
      if (invalid) {
        onError?.(invalid);
        return;
      }
      setVehicleUploading(true);
      try {
        // Pipeline NORMAL de upload (resize ≤1600px + recorte opcional) —
        // o veículo entra na biblioteca já otimizado, nada pesado.
        const result = await uploadProductImage(file, {
          removeBackground: vehicleRemoveBg,
          addShadow: false,
        });
        // Degradação do recorte não trava a inserção: o arquivo otimizado
        // sempre volta e o usuário VÊ o resultado no canvas.
        const fileName =
          result.fileName ?? result.url.slice(result.url.lastIndexOf("/") + 1);
        const registered = await registerEditorAsset({
          fileName,
          label: file.name.slice(0, 60),
        });
        const asset: EditorAssetRef =
          registered ?? { id: "", fileName, label: file.name, url: result.url };
        if (registered) {
          setVehicleAssets((prev) => [registered, ...prev]);
        }
        handleInsertVehicle(asset);
      } catch (err) {
        onError?.(classifyUploadError(err).message);
      } finally {
        setVehicleUploading(false);
      }
    },
    [vehicleRemoveBg, handleInsertVehicle, onError],
  );


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
    // Fontes ANTES do export: texto desenhado com fallback sairia "pulado"
    // nos pixels finais (PR 7).
    await ensureEditorFontsLoaded();
    // Fundo transparente => PNG; opaco => JPEG q0.9 (menor, padrão de anúncio).
    const format = background.mode === "transparent" ? "png" : "jpeg";
    const dataUrl = editor.exportImage(format, 0.9);
    if (!dataUrl) return;
    setSaving(true);
    try {
      const blob = await dataUrlToBlob(dataUrl);
      const c = editor.getCanvas();
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
        // Camadas de anotação (PR 7): o restore reconstrói 1:1 na reabertura.
        layers: c ? serializeAnnotations(c) : [],
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

            {/* Host do textarea invisível do IText: caixa de tamanho ZERO,
                `fixed` (bloco de contenção na origem do viewport, que é o
                mesmo referencial de canvas._offset dentro deste Content
                `fixed`) e `overflow: hidden` — o navegador só consegue rolar
                uma caixa vazia, nunca o wrapper do canvas. Ver text-editing.ts. */}
            <div ref={textareaHostRef} style={TEXTAREA_HOST_STYLE} />

            {/* Canvas + camadas (sidebar no desktop usa o espaço vazio à
                direita — no celular as camadas viram chips abaixo) */}
            <div className="flex min-h-0 flex-1 gap-3">
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

            {annotationObjects.length > 0 && canvas && (
              <aside className="hidden w-48 shrink-0 flex-col gap-1 self-stretch overflow-y-auto rounded-md border bg-muted/20 p-1.5 sm:flex">
                <span className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Camadas
                </span>
                {[...annotationObjects].reverse().map((obj, i) => (
                  <div
                    key={`layer-${i}`}
                    className={`rounded-md border px-1.5 py-1 ${
                      activeObject === obj
                        ? "border-primary bg-primary/10"
                        : "border-transparent hover:bg-muted"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        enterAnnotate();
                        canvas.setActiveObject(obj);
                        canvas.requestRenderAll();
                        bumpTick();
                      }}
                      className="block w-full truncate text-left text-xs"
                    >
                      {annotationLabel(obj)}
                    </button>
                    {activeObject === obj && (
                      <div className="mt-1 flex items-center gap-0.5">
                        <Button type="button" size="icon" variant="ghost" className="h-5 w-5" title="Trazer para frente"
                          onClick={() => { moveAnnotation(canvas, obj, "up"); markDirty(); bumpTick(); }}>
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" className="h-5 w-5" title="Enviar para trás"
                          onClick={() => { moveAnnotation(canvas, obj, "down"); markDirty(); bumpTick(); }}>
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" className="h-5 w-5" title="Duplicar"
                          onClick={() => { duplicateAnnotation(canvas, obj); markDirty(); bumpTick(); }}>
                          <Copy className="h-3 w-3" />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" className="h-5 w-5 text-destructive" title="Excluir"
                          onClick={() => { removeAnnotation(canvas, obj); markDirty(); bumpTick(); }}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </aside>
            )}
            </div>

            {/* Warning ML não-bloqueante (política: foto principal sem
                textos/logos/promoções sobre a imagem) */}
            {shouldWarnMlAnnotations(presetId, annotationObjects.length) && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                O Mercado Livre não permite textos, setas ou logos na foto
                PRINCIPAL do anúncio — use esta imagem como secundária ou
                troque o tamanho.
              </div>
            )}

            {/* Anotações (PR 7) */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "move" ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  title="Mover/escalar/girar a peça"
                  onClick={() => {
                    const a = editor.getCanvas()?.getActiveObject() as
                      | (IText & { isEditing?: boolean; exitEditing?: () => void })
                      | undefined;
                    if (a?.isEditing) a.exitEditing?.();
                    setMode("move");
                  }}
                >
                  <Move className="mr-1 h-3.5 w-3.5" />
                  Mover peça
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "annotate" ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  title="Peça travada; edite as anotações"
                  onClick={enterAnnotate}
                >
                  Anotar
                </Button>
              </div>

              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={handleAddText}
                  disabled={!editor.ready}
                >
                  <Type className="mr-1 h-3.5 w-3.5" />
                  Texto
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={handleAddArrow}
                  disabled={!editor.ready}
                >
                  <ArrowUpRight className="mr-1 h-3.5 w-3.5" />
                  Seta
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={handleAddEllipse}
                  disabled={!editor.ready}
                >
                  <Circle className="mr-1 h-3.5 w-3.5" />
                  Círculo
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={vehiclePanelOpen ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  onClick={openVehiclePanel}
                  disabled={!editor.ready}
                  title="Inserir um veículo da sua biblioteca (padrão peça + carro compatível)"
                >
                  <Car className="mr-1 h-3.5 w-3.5" />
                  Veículo
                </Button>
              </div>

              {/* Camadas: chips clicáveis (última = mais acima) + ações da
                  camada selecionada */}
              {annotationObjects.length > 0 && canvas && (
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:hidden">
                  {annotationObjects.map((obj, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        enterAnnotate();
                        canvas.setActiveObject(obj);
                        canvas.requestRenderAll();
                        setCanvasTick((t) => t + 1);
                      }}
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                        activeObject === obj
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-muted/40 text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {annotationLabel(obj)}
                    </button>
                  ))}
                </div>
              )}

              {activeObject && canvas && kindOf(activeObject) !== "base" && (
                <div className="flex items-center gap-1 sm:hidden">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    title="Trazer para frente"
                    onClick={() => {
                      moveAnnotation(canvas, activeObject, "up");
                      markDirty();
                      bumpTick();
                    }}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    title="Enviar para trás"
                    onClick={() => {
                      moveAnnotation(canvas, activeObject, "down");
                      markDirty();
                      bumpTick();
                    }}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    title="Duplicar"
                    onClick={() => {
                      duplicateAnnotation(canvas, activeObject);
                      markDirty();
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    className="h-7 w-7"
                    title="Excluir camada"
                    onClick={() => {
                      removeAnnotation(canvas, activeObject);
                      markDirty();
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>

            {/* Biblioteca de veículos (lazy; miniaturas otimizadas) */}
            {vehiclePanelOpen && (
              <div className="rounded-md border bg-muted/20 p-2">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input
                    ref={vehicleInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleVehicleUpload(f);
                      if (vehicleInputRef.current)
                        vehicleInputRef.current.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={vehicleUploading}
                    onClick={() => vehicleInputRef.current?.click()}
                  >
                    {vehicleUploading ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Car className="mr-1 h-3.5 w-3.5" />
                    )}
                    Enviar veículo do computador
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={vehicleRemoveBg ? "default" : "outline"}
                    className="h-7 px-2 text-xs"
                    title="Remover o fundo do veículo ao enviar (recomendado)"
                    onClick={() => setVehicleRemoveBg((v) => !v)}
                  >
                    Remover fundo
                  </Button>
                  {vehicleUploading && (
                    <span className="text-[10px] text-muted-foreground">
                      Otimizando{vehicleRemoveBg ? " e recortando" : ""} o
                      veículo…
                    </span>
                  )}
                </div>
                {vehicleAssets.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    Sua biblioteca está vazia — envie a foto de um veículo uma
                    vez e reuse em quantos anúncios quiser.
                  </p>
                ) : (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {vehicleAssets.map((asset) => (
                      <div key={asset.id || asset.fileName} className="group relative shrink-0">
                        <button
                          type="button"
                          onClick={() => handleInsertVehicle(asset)}
                          title={asset.label ?? "Inserir veículo"}
                          className="block h-16 w-24 overflow-hidden rounded border bg-background hover:ring-2 hover:ring-primary"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={asset.url}
                            alt={asset.label ?? "Veículo"}
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-contain"
                          />
                        </button>
                        {asset.id && (
                          <button
                            type="button"
                            title="Remover da biblioteca"
                            onClick={() => {
                              void deleteEditorAsset(asset.id);
                              setVehicleAssets((prev) =>
                                prev.filter((a) => a.id !== asset.id),
                              );
                            }}
                            className="absolute -top-1 -right-1 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Estilo do TEXTO selecionado */}
            {activeText && canvas && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/20 px-2 py-1.5">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  title="Ou dê um duplo clique/toque no texto"
                  onClick={() => {
                    beginTextEditing(canvas, activeText);
                    markDirty();
                    bumpTick();
                  }}
                >
                  <Type className="mr-1 h-3.5 w-3.5" />
                  Editar texto
                </Button>
                <Select
                  value={(activeText.fontFamily as string) ?? EDITOR_FONTS[0].family}
                  onValueChange={(v) => {
                    applyTextStyle(canvas, activeText, { fontFamily: v });
                    markDirty();
                    bumpTick();
                  }}
                >
                  <SelectTrigger className="h-7 w-[180px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EDITOR_FONTS.map((f) => (
                      <SelectItem key={f.family} value={f.family} className="text-xs">
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex items-center gap-1.5">
                  <Label className="text-xs">Tamanho</Label>
                  <Slider
                    value={[activeText.fontSize ?? 64]}
                    min={24}
                    max={200}
                    step={2}
                    className="w-[110px]"
                    onValueChange={([v]) => {
                      applyTextStyle(canvas, activeText, { fontSize: v });
                      markDirty();
                      bumpTick();
                    }}
                  />
                </div>

                <div className="flex items-center gap-1">
                  {ANNOTATION_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      title={color}
                      onClick={() => {
                        applyTextStyle(canvas, activeText, { fill: color });
                        markDirty();
                        bumpTick();
                      }}
                      className={`h-5 w-5 shrink-0 rounded-full border-2 ${
                        activeText.fill === color
                          ? "border-primary"
                          : "border-muted-foreground/30"
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant={activeText.fontWeight === "bold" ? "default" : "outline"}
                  className="h-7 w-7 px-0 text-xs font-bold"
                  title="Negrito"
                  onClick={() => {
                    applyTextStyle(canvas, activeText, {
                      bold: activeText.fontWeight !== "bold",
                    });
                    markDirty();
                    bumpTick();
                  }}
                >
                  B
                </Button>

                <Button
                  type="button"
                  size="sm"
                  variant={activeText.stroke ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  title="Contorno de contraste atrás das letras"
                  onClick={() => {
                    applyTextStyle(canvas, activeText, {
                      outline: !activeText.stroke,
                    });
                    markDirty();
                    bumpTick();
                  }}
                >
                  Contorno
                </Button>
              </div>
            )}

            {/* Cor da SETA/CÍRCULO selecionado — mesma paleta do texto */}
            {activeShape && canvas && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/20 px-2 py-1.5">
                <Label className="text-xs">
                  Cor {kindOf(activeShape) === "arrow" ? "da seta" : "do círculo"}
                </Label>
                <div className="flex items-center gap-1">
                  {ANNOTATION_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      title={color}
                      onClick={() => {
                        applyShapeStroke(canvas, activeShape, color);
                        markDirty();
                        bumpTick();
                      }}
                      className={`h-5 w-5 shrink-0 rounded-full border-2 ${
                        activeShape.stroke === color
                          ? "border-primary"
                          : "border-muted-foreground/30"
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Toolbar — embaixo (polegar no celular) */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex items-center gap-2">
                <Label className="text-xs whitespace-nowrap">Tamanho</Label>
                <Select
                  value={presetId}
                  onValueChange={(v) => {
                    // Sem o remap, as camadas ficariam nas coordenadas do
                    // canvas ANTIGO — fora do export e inalcançáveis.
                    const c = editor.getCanvas();
                    if (c) {
                      remapAnnotations(
                        c,
                        exportSize,
                        presetExportSize(resolvePreset(v), sourceSize),
                      );
                    }
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
