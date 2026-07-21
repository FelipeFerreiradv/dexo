"use client";

import { useCallback, useMemo, useState, type ChangeEvent } from "react";
import { useSession } from "next-auth/react";
import { CheckCircle2, Layers, Loader2, Plus, Trash2, XCircle } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import {
  LocationCombobox,
  type LocationSelectItem,
} from "@/app/produtos/components/location-combobox";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_LOCATIONS_PER_ROW,
  MAX_PADDING,
  MAX_TOTAL_LOCATIONS,
  describeBatchError,
  describeRowError,
  validateBulkLocationRows,
  type BulkLocationRow,
} from "../lib/bulk-locations";

interface BulkLocationsDialogProps {
  onToast: (message: string, type: "success" | "error" | "warning") => void;
  /** Recarrega a lista após criar (só é chamado quando algo foi criado). */
  onCreated: () => void | Promise<void>;
}

/** Linha do formulário: a faixa + estado de UI (id da linha e caminho da mãe). */
interface BulkRow extends BulkLocationRow {
  rowId: string;
  parentPath: string;
}

interface BulkResult {
  summary: { requested: number; created: number; skipped: number; failed: number };
  created: Array<{ id: string; code: string }>;
  skipped: Array<{ code: string; reason: "ja_existe" | "duplicada_no_lote" }>;
  failed: Array<{ code: string; error: string }>;
}

const createEmptyRow = (): BulkRow => ({
  rowId: crypto.randomUUID(),
  prefix: "",
  start: "",
  end: "",
  padding: "",
  maxCapacity: "0",
  description: "",
  parentId: null,
  parentPath: "",
});

const pluralizeLocations = (total: number): string =>
  `${total} localização${total === 1 ? "" : "ões"}`;

/**
 * A faixa ocupa DUAS linhas de campos em vez de espremer sete colunas numa só:
 * em cima o prefixo e os números (curtos), embaixo descrição e localização-mãe,
 * que precisam de largura para o texto não truncar. Numa única linha o combobox
 * de mãe encostava no botão de remover.
 */
const GRID_TOP =
  "md:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_4.5rem_5rem_auto]";

/**
 * Criação de localizações em massa a partir de faixas (PRT-1 … PRT-40).
 * Espelha o padrão de linhas add/remove da Etiqueta Avulsa
 * (`app/produtos/components/standalone-label-dialog.tsx`), mas aqui o lote é
 * PERSISTIDO: o submit chama `POST /locations/bulk`, que reexpande as mesmas
 * faixas com a mesma lib pura usada no preview.
 */
export function BulkLocationsDialog({
  onToast,
  onCreated,
}: BulkLocationsDialogProps) {
  const { data: session } = useSession();
  const email = session?.user?.email;

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BulkRow[]>(() => [createEmptyRow()]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [parentOptions, setParentOptions] = useState<LocationSelectItem[]>([]);
  const [result, setResult] = useState<BulkResult | null>(null);

  const validation = useMemo(() => validateBulkLocationRows(rows), [rows]);

  const loadParents = useCallback(async () => {
    if (!email) return;
    try {
      const response = await fetch(`${getApiBaseUrl()}/locations/select`, {
        headers: { email },
      });
      const data = await response.json();
      if (response.ok) setParentOptions(data.locations ?? []);
    } catch {
      // Silencioso: sem opções, o seletor mostra apenas "Nenhuma" (raiz).
    }
  }, [email]);

  const handleOpenChange = (next: boolean) => {
    if (isSubmitting) return;
    if (next) {
      setRows([createEmptyRow()]);
      setResult(null);
      // Reabrir não re-busca: a lista só é invalidada após criar um lote
      // (quando as novas localizações passam a valer como mãe).
      if (parentOptions.length === 0) void loadParents();
    }
    setOpen(next);
  };

  const addRow = () => setRows((prev) => [...prev, createEmptyRow()]);

  const removeRow = (rowId: string) =>
    setRows((prev) =>
      prev.length > 1 ? prev.filter((row) => row.rowId !== rowId) : prev,
    );

  const updateRow = (rowId: string, patch: Partial<BulkRow>) =>
    setRows((prev) =>
      prev.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    );

  const handleNumberChange =
    (rowId: string, field: "start" | "end" | "padding" | "maxCapacity") =>
    (event: ChangeEvent<HTMLInputElement>) =>
      updateRow(rowId, { [field]: event.target.value } as Partial<BulkRow>);

  const handleSubmit = async () => {
    if (!validation.canGenerate || isSubmitting) return;
    if (!email) {
      onToast("Sessão expirada. Recarregue a página.", "error");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        rows: rows.map((row) => ({
          prefix: row.prefix,
          start: row.start,
          end: row.end,
          padding: row.padding,
          maxCapacity: row.maxCapacity,
          description: row.description,
          parentId: row.parentId ?? null,
        })),
      };

      const response = await fetch(`${getApiBaseUrl()}/locations/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || "Erro ao criar localizações");
      }

      const data = body as BulkResult;
      if (data.summary.created > 0) {
        await onCreated();
        // As recém-criadas passam a ser mães válidas na próxima abertura.
        setParentOptions([]);
      }

      const hasPending = data.summary.skipped > 0 || data.summary.failed > 0;
      if (hasPending) {
        onToast(
          `${data.summary.created} criadas · ${data.summary.skipped} já existiam · ${data.summary.failed} com erro`,
          "warning",
        );
        // Troca o conteúdo do MESMO diálogo pelo relatório: abrir um segundo
        // modal enquanto este fecha deixa `pointer-events: none` preso no body.
        setResult(data);
      } else {
        onToast(`${pluralizeLocations(data.summary.created)} criadas!`, "success");
        setOpen(false);
      }
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Erro ao criar localizações",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (result) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline">
            <Layers className="mr-2 size-4" />
            Criar em massa
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <BulkLocationsResult result={result} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" disabled={isSubmitting}>
            <Layers className="mr-2 size-4" />
            Criar em massa
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="size-5" />
              Criar localizações em massa
            </DialogTitle>
            <DialogDescription>
              Cada faixa gera uma sequência de localizações (ex.: PRT- de 1 a 40).
              Siglas que já existirem são puladas e reportadas ao final.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[55vh] space-y-3 overflow-y-auto py-1">
            <div className="space-y-3">
              {rows.map((row, index) => {
                const rv = validation.rows[index];
                // Só sinaliza erro numa linha "suja", para não pintar de
                // vermelho a linha vazia inicial.
                const rowDirty =
                  String(row.prefix ?? "").trim() !== "" ||
                  String(row.start ?? "") !== "" ||
                  String(row.end ?? "") !== "";
                const rowError = rowDirty ? describeRowError(rv) : null;

                return (
                  <div
                    key={row.rowId}
                    className="space-y-2 rounded-lg border p-3 md:space-y-1.5"
                  >
                    <div className={cn("grid grid-cols-1 items-end gap-2", GRID_TOP)}>
                      <div className="grid min-w-0 gap-1">
                        <Label
                          htmlFor={`${row.rowId}-prefix`}
                          className="text-xs text-muted-foreground"
                        >
                          Prefixo
                        </Label>
                        <Input
                          id={`${row.rowId}-prefix`}
                          value={String(row.prefix ?? "")}
                          placeholder="PRT-"
                          className="uppercase"
                          aria-label="Prefixo da faixa"
                          aria-invalid={rowDirty && !rv.prefixOk ? true : undefined}
                          onChange={(event) =>
                            updateRow(row.rowId, { prefix: event.target.value })
                          }
                        />
                      </div>

                      {/* De · Até · Dígitos ficam lado a lado no mobile e viram
                          colunas soltas no desktop (md:contents). */}
                      <div className="grid grid-cols-3 gap-2 md:contents">
                        <div className="grid gap-1">
                          <Label
                            htmlFor={`${row.rowId}-start`}
                            className="text-xs text-muted-foreground"
                          >
                            De
                          </Label>
                          <Input
                            id={`${row.rowId}-start`}
                            type="number"
                            inputMode="numeric"
                            value={String(row.start ?? "")}
                            placeholder="1"
                            aria-label="Número inicial"
                            aria-invalid={
                              rowDirty && (!rv.startOk || !rv.rangeOk) ? true : undefined
                            }
                            onChange={handleNumberChange(row.rowId, "start")}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label
                            htmlFor={`${row.rowId}-end`}
                            className="text-xs text-muted-foreground"
                          >
                            Até
                          </Label>
                          <Input
                            id={`${row.rowId}-end`}
                            type="number"
                            inputMode="numeric"
                            value={String(row.end ?? "")}
                            placeholder="40"
                            aria-label="Número final"
                            aria-invalid={
                              rowDirty && (!rv.endOk || !rv.rangeOk || !rv.countOk)
                                ? true
                                : undefined
                            }
                            onChange={handleNumberChange(row.rowId, "end")}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label
                            htmlFor={`${row.rowId}-padding`}
                            className="text-xs text-muted-foreground"
                          >
                            Dígitos
                          </Label>
                          <Input
                            id={`${row.rowId}-padding`}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={MAX_PADDING}
                            value={String(row.padding ?? "")}
                            placeholder="0"
                            aria-label="Zeros à esquerda"
                            onChange={handleNumberChange(row.rowId, "padding")}
                          />
                        </div>
                      </div>

                      <div className="grid gap-1">
                        <Label
                          htmlFor={`${row.rowId}-capacity`}
                          className="text-xs text-muted-foreground"
                        >
                          Cap.
                        </Label>
                        <Input
                          id={`${row.rowId}-capacity`}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={String(row.maxCapacity ?? "")}
                          placeholder="0"
                          aria-label="Capacidade máxima"
                          aria-invalid={rowDirty && !rv.capacityOk ? true : undefined}
                          onChange={handleNumberChange(row.rowId, "maxCapacity")}
                        />
                      </div>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0 justify-self-end text-muted-foreground hover:text-destructive"
                        disabled={rows.length === 1}
                        onClick={() => removeRow(row.rowId)}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">Remover faixa</span>
                      </Button>
                    </div>

                    {/* Segunda linha: os dois campos de texto largo. Ficam fora
                        do grid de cima para o combobox de mãe ter espaço real
                        e nunca encostar no botão de remover. */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="grid min-w-0 gap-1">
                        <Label
                          htmlFor={`${row.rowId}-description`}
                          className="text-xs text-muted-foreground"
                        >
                          Descrição
                        </Label>
                        <Input
                          id={`${row.rowId}-description`}
                          value={row.description ?? ""}
                          maxLength={MAX_DESCRIPTION_LENGTH}
                          placeholder="Opcional"
                          aria-label="Descrição das localizações"
                          aria-invalid={rowDirty && !rv.descriptionOk ? true : undefined}
                          onChange={(event) =>
                            updateRow(row.rowId, { description: event.target.value })
                          }
                        />
                      </div>

                      <div className="grid min-w-0 gap-1">
                        <Label
                          htmlFor={`${row.rowId}-parent`}
                          className="text-xs text-muted-foreground"
                        >
                          Dentro de
                        </Label>
                        {/* allowFull: capacidade conta produtos, não filhas —
                            uma localização lotada ainda pode ser mãe. */}
                        <LocationCombobox
                          id={`${row.rowId}-parent`}
                          allowFull
                          options={parentOptions}
                          value={row.parentId ?? null}
                          onChange={(id, fullPath) =>
                            updateRow(row.rowId, { parentId: id, parentPath: fullPath })
                          }
                        />
                      </div>
                    </div>

                    <p
                      className={cn(
                        "text-xs",
                        rowError ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {rowError ??
                        (rv.count > 0
                          ? `${rv.sampleFirst.join(", ")}${
                              rv.count > rv.sampleFirst.length ? ` … ${rv.sampleLast}` : ""
                            } · ${pluralizeLocations(rv.count)}${
                              row.parentPath ? ` em ${row.parentPath}` : " na raiz"
                            }`
                          : "Informe prefixo, início e fim")}
                    </p>
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
              Adicionar faixa
            </Button>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              {validation.canGenerate ? (
                <span className="text-muted-foreground">
                  {pluralizeLocations(validation.totalLocations)} serão criadas
                </span>
              ) : (
                <span
                  className={cn(
                    validation.overCap || validation.tooManyRows
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {describeBatchError(validation) ??
                    "Preencha prefixo, início e fim em todas as faixas"}
                </span>
              )}
            </div>

            <div className="flex gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isSubmitting}>
                  Cancelar
                </Button>
              </DialogClose>
              <Button
                type="button"
                className="gap-2"
                onClick={handleSubmit}
                disabled={!validation.canGenerate || isSubmitting}
              >
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Layers className="size-4" />
                )}
                {isSubmitting
                  ? "Criando..."
                  : validation.canGenerate
                    ? `Criar ${pluralizeLocations(validation.totalLocations)}`
                    : "Criar localizações"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Relatório do lote, renderizado no lugar do formulário quando alguma sigla é
 * pulada ou falha — o toast da lista só aceita string e some em 4s. Mesmo
 * propósito do `bulk-delete-result-modal` de produtos.
 */
function BulkLocationsResult({
  result,
  onClose,
}: {
  result: BulkResult;
  onClose: () => void;
}) {
  const { summary, created, failed } = result;
  const alreadyExisted = result.skipped.filter((s) => s.reason === "ja_existe");
  const duplicatedInBatch = result.skipped.filter(
    (s) => s.reason === "duplicada_no_lote",
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Resultado do lote</DialogTitle>
        <DialogDescription>
          {summary.created} criadas · {summary.skipped} puladas ·{" "}
          {summary.failed} com erro
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto">
        {created.length > 0 && (
          <section className="space-y-1">
            <h4 className="flex items-center gap-2 text-sm font-medium text-emerald-600">
              <CheckCircle2 className="size-4" />
              Criadas ({created.length})
            </h4>
            <p className="font-mono text-xs text-muted-foreground">
              {created.map((c) => c.code).join(", ")}
            </p>
          </section>
        )}

        {alreadyExisted.length > 0 && (
          <section className="space-y-1">
            <h4 className="text-sm font-medium text-amber-600">
              Já existiam ({alreadyExisted.length})
            </h4>
            <p className="font-mono text-xs text-muted-foreground">
              {alreadyExisted.map((s) => s.code).join(", ")}
            </p>
          </section>
        )}

        {duplicatedInBatch.length > 0 && (
          <section className="space-y-1">
            <h4 className="text-sm font-medium text-amber-600">
              Repetidas no lote ({duplicatedInBatch.length})
            </h4>
            <p className="font-mono text-xs text-muted-foreground">
              {duplicatedInBatch.map((s) => s.code).join(", ")}
            </p>
          </section>
        )}

        {failed.length > 0 && (
          <section className="space-y-1">
            <h4 className="flex items-center gap-2 text-sm font-medium text-destructive">
              <XCircle className="size-4" />
              Com erro ({failed.length})
            </h4>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {failed.map((f) => (
                <li key={f.code}>
                  <span className="font-mono">{f.code}</span> — {f.error}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <DialogFooter>
        <Button type="button" onClick={onClose}>
          Fechar
        </Button>
      </DialogFooter>
    </>
  );
}
