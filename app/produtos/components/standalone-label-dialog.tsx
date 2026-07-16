"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { Loader2, Plus, QrCode, Tag, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_QUANTITY_PER_ITEM,
  MAX_TOTAL_LABELS,
  validateStandaloneLabelItems,
} from "@/app/produtos/lib/standalone-labels";
import { generateStandaloneLabelsPdf } from "@/app/produtos/lib/standalone-labels-pdf";

// Modal de "Etiqueta avulsa": monta uma LISTA de etiquetas de produtos diferentes
// (cada linha Nome + SKU + Quantidade) e gera um único PDF, no mesmo layout do
// fluxo de "Gerar etiquetas", porém ANTES de os produtos existirem. Nada é
// persistido — é efêmero e client-side. O QR de cada etiqueta é o SKU da linha.

interface StandaloneLabelDialogProps {
  userName?: string | null;
  onToast: (message: string, type: "success" | "error" | "warning") => void;
}

interface LabelRow {
  // rowId é só para key/edição de UI — nada a ver com produto.
  rowId: string;
  name: string;
  sku: string;
  quantity: number;
}

const createEmptyRow = (): LabelRow => ({
  rowId: crypto.randomUUID(),
  name: "",
  sku: "",
  quantity: 1,
});

const pluralizeLabels = (total: number): string =>
  `${total} etiqueta${total === 1 ? "" : "s"}`;

export function StandaloneLabelDialog({
  userName,
  onToast,
}: StandaloneLabelDialogProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LabelRow[]>(() => [createEmptyRow()]);
  const [isGenerating, setIsGenerating] = useState(false);

  const validation = useMemo(
    () => validateStandaloneLabelItems(rows),
    [rows],
  );

  const handleOpenChange = (next: boolean) => {
    // Não abre/fecha no meio da geração.
    if (isGenerating) return;
    // Reabrir começa com uma linha vazia — não persiste nada entre aberturas.
    if (next) setRows([createEmptyRow()]);
    setOpen(next);
  };

  const addRow = () => setRows((prev) => [...prev, createEmptyRow()]);

  const removeRow = (rowId: string) =>
    setRows((prev) =>
      prev.length > 1 ? prev.filter((row) => row.rowId !== rowId) : prev,
    );

  const updateRow = (rowId: string, patch: Partial<LabelRow>) =>
    setRows((prev) =>
      prev.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    );

  const handleQuantityChange =
    (rowId: string) => (event: ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.valueAsNumber;
      const next = Number.isFinite(raw)
        ? Math.min(MAX_QUANTITY_PER_ITEM, Math.max(1, Math.floor(raw)))
        : 1;
      updateRow(rowId, { quantity: next });
    };

  const handleGenerate = async () => {
    if (!validation.canGenerate || isGenerating) return;
    setIsGenerating(true);
    try {
      const result = await generateStandaloneLabelsPdf({ items: rows, userName });
      onToast(
        result === "downloaded"
          ? "Pop-up bloqueado: etiquetas baixadas em vez de abertas."
          : "PDF de etiquetas gerado com sucesso!",
        result === "downloaded" ? "warning" : "success",
      );
      setOpen(false);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Erro ao gerar etiquetas",
        "error",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={isGenerating}
        >
          <Tag className="size-4" />
          Etiqueta avulsa
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="size-5" />
            Etiqueta avulsa
          </DialogTitle>
          <DialogDescription>
            Gere etiquetas para produtos que ainda não existem. Cada linha vira
            uma etiqueta (o QR guarda o SKU); a quantidade define quantas cópias.
            Nada é salvo.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-3 overflow-y-auto py-1">
          <div className="space-y-2">
            {/* Cabeçalho de colunas (desktop) */}
            <div className="hidden gap-2 px-1 sm:grid sm:grid-cols-[1fr_9rem_4.5rem_auto]">
              <span className="text-xs font-medium text-muted-foreground">
                Nome
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                SKU
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                Qtd.
              </span>
              <span className="w-9" aria-hidden />
            </div>

            {rows.map((row, index) => {
              const rowValidation = validation.rows[index];
              // Só sinaliza erro numa linha "suja" (usuário começou a preencher),
              // para não pintar de vermelho a linha vazia inicial.
              const rowDirty =
                row.name.trim() !== "" || row.sku.trim() !== "";
              const nameInvalid = rowDirty && !rowValidation.nameOk;
              const skuInvalid = rowDirty && !rowValidation.skuOk;

              return (
                <div
                  key={row.rowId}
                  className="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_9rem_4.5rem_auto] sm:items-center sm:rounded-none sm:border-0 sm:p-0"
                >
                  <div className="grid gap-1">
                    <Label
                      htmlFor={`${row.rowId}-name`}
                      className="text-xs text-muted-foreground sm:hidden"
                    >
                      Nome
                    </Label>
                    <Input
                      id={`${row.rowId}-name`}
                      value={row.name}
                      placeholder="Nome do produto"
                      aria-label="Nome da etiqueta"
                      aria-invalid={nameInvalid ? true : undefined}
                      onChange={(event) =>
                        updateRow(row.rowId, { name: event.target.value })
                      }
                    />
                  </div>

                  <div className="grid gap-1">
                    <Label
                      htmlFor={`${row.rowId}-sku`}
                      className="text-xs text-muted-foreground sm:hidden"
                    >
                      SKU
                    </Label>
                    <Input
                      id={`${row.rowId}-sku`}
                      value={row.sku}
                      placeholder="SKU"
                      aria-label="SKU da etiqueta"
                      aria-invalid={skuInvalid ? true : undefined}
                      onChange={(event) =>
                        updateRow(row.rowId, { sku: event.target.value })
                      }
                    />
                  </div>

                  <div className="grid gap-1">
                    <Label
                      htmlFor={`${row.rowId}-qty`}
                      className="text-xs text-muted-foreground sm:hidden"
                    >
                      Qtd.
                    </Label>
                    <Input
                      id={`${row.rowId}-qty`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_QUANTITY_PER_ITEM}
                      value={row.quantity}
                      aria-label="Quantidade de cópias"
                      onChange={handleQuantityChange(row.rowId)}
                    />
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="justify-self-end text-muted-foreground hover:text-destructive"
                    disabled={rows.length === 1}
                    onClick={() => removeRow(row.rowId)}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">Remover etiqueta</span>
                  </Button>
                </div>
              );
            })}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={addRow}
          >
            <Plus className="size-4" />
            Adicionar etiqueta
          </Button>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            {validation.overCap ? (
              <span className="text-destructive">
                Máximo de {MAX_TOTAL_LABELS} etiquetas por PDF (
                {validation.totalLabels} no momento).
              </span>
            ) : validation.canGenerate ? (
              <span className="text-muted-foreground">
                {pluralizeLabels(validation.totalLabels)} no PDF
              </span>
            ) : (
              <span className="text-muted-foreground">
                Preencha nome e SKU em todas as etiquetas
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isGenerating}>
                Cancelar
              </Button>
            </DialogClose>
            <Button
              type="button"
              className="gap-2"
              onClick={handleGenerate}
              disabled={!validation.canGenerate || isGenerating}
            >
              {isGenerating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <QrCode className="size-4" />
              )}
              {isGenerating
                ? "Gerando..."
                : validation.canGenerate
                  ? `Gerar ${pluralizeLabels(validation.totalLabels)}`
                  : "Gerar etiquetas"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
