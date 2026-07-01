"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  CalendarClock,
  FileDown,
  GripVertical,
  Loader2,
  Pencil,
  ShoppingCart,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatToBRL } from "@/components/ui/currency-input";
import { cn } from "@/lib/utils";
import {
  COLUMN_ACCENT,
  COLUMN_INDEX,
  COLUMN_LABEL,
  COLUMN_ORDER,
  FONT_DISPLAY,
  FONT_SERIF,
  type ColumnKey,
  type CrmBudget,
  deriveColumn,
  isExpired,
  isOpenColumn,
} from "./budget-crm-shared";

interface Props {
  budgets: CrmBudget[];
  busyId: string | null;
  onMove: (budgetId: string, to: ColumnKey) => void;
  onEdit: (b: CrmBudget) => void;
  onPdf: (b: CrmBudget) => void;
  onConvert: (b: CrmBudget) => void;
}

export function BudgetKanban({
  budgets,
  busyId,
  onMove,
  onEdit,
  onPdf,
  onConvert,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    // distance:8 => um clique nos botões de ação NÃO inicia arrasto.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const columns = useMemo(() => {
    const map: Record<ColumnKey, CrmBudget[]> = {
      NOVO: [],
      EM_NEGOCIACAO: [],
      PROPOSTA_ENVIADA: [],
      GANHO: [],
      PERDIDO: [],
      CANCELADO: [],
    };
    for (const b of budgets) map[deriveColumn(b)].push(b);
    return map;
  }, [budgets]);

  const activeBudget = activeId
    ? (budgets.find((b) => b.id === activeId) ?? null)
    : null;

  const handleDragStart = (e: DragStartEvent) =>
    setActiveId(String(e.active.id));

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const over = e.over;
    if (!over) return;
    const to = String(over.id) as ColumnKey;
    onMove(String(e.active.id), to);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex gap-4 overflow-x-auto pb-4 pt-1 [scrollbar-width:thin]">
        {COLUMN_ORDER.map((key) => (
          <Column
            key={key}
            columnKey={key}
            items={columns[key]}
            busyId={busyId}
            onEdit={onEdit}
            onPdf={onPdf}
            onConvert={onConvert}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeBudget ? (
          <CardShell
            budget={activeBudget}
            dragging
            className="cursor-grabbing"
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  columnKey,
  items,
  busyId,
  onEdit,
  onPdf,
  onConvert,
}: {
  columnKey: ColumnKey;
  items: CrmBudget[];
  busyId: string | null;
  onEdit: (b: CrmBudget) => void;
  onPdf: (b: CrmBudget) => void;
  onConvert: (b: CrmBudget) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnKey });
  const total = items.reduce((s, b) => s + (b.totalAmount || 0), 0);
  const draggable = isOpenColumn(columnKey);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-[288px] shrink-0 flex-col rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm transition-colors",
        isOver && "border-primary/70 bg-primary/[0.06] ring-1 ring-primary/40",
      )}
    >
      {/* Cabeçalho-etiqueta: index mono + nome em caixa-alta tracked + spine */}
      <div className="flex items-stretch gap-3 px-3 pt-3">
        <span
          className={cn("w-1 shrink-0 rounded-full", COLUMN_ACCENT[columnKey])}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] font-medium text-muted-foreground/70">
              {COLUMN_INDEX[columnKey]}
            </span>
            <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/90">
              {COLUMN_LABEL[columnKey]}
            </span>
          </div>
          <div className="mt-1 flex items-end justify-between gap-2">
            <span
              className={cn(
                "text-3xl leading-none tabular-nums text-foreground",
                FONT_SERIF,
              )}
            >
              {items.length}
            </span>
            <span className="pb-0.5 font-mono text-[11px] text-muted-foreground">
              R$ {formatToBRL(total)}
            </span>
          </div>
        </div>
      </div>

      <div className="mx-3 mt-3 border-t border-dashed border-border/60" />

      <div className="flex flex-1 flex-col gap-2 p-2">
        {items.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/50 px-3 py-8 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
            vazio
          </div>
        )}
        {items.map((b) => (
          <DraggableCard
            key={b.id}
            budget={b}
            columnKey={columnKey}
            draggable={draggable}
            busyId={busyId}
            onEdit={onEdit}
            onPdf={onPdf}
            onConvert={onConvert}
          />
        ))}
      </div>
    </div>
  );
}

function DraggableCard({
  budget,
  columnKey,
  draggable,
  busyId,
  onEdit,
  onPdf,
  onConvert,
}: {
  budget: CrmBudget;
  columnKey: ColumnKey;
  draggable: boolean;
  busyId: string | null;
  onEdit: (b: CrmBudget) => void;
  onPdf: (b: CrmBudget) => void;
  onConvert: (b: CrmBudget) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: budget.id, disabled: !draggable });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "opacity-40")}
    >
      <CardShell
        budget={budget}
        columnKey={columnKey}
        busyId={busyId}
        handleProps={draggable ? { ...listeners, ...attributes } : undefined}
        onEdit={onEdit}
        onPdf={onPdf}
        onConvert={onConvert}
      />
    </div>
  );
}

// Cartão (identidade Dexo — creme catálogo, spine de cor, dado em mono).
// Reutilizado no DragOverlay (dragging) e nas colunas.
function CardShell({
  budget: b,
  columnKey,
  busyId,
  dragging,
  handleProps,
  className,
  onEdit,
  onPdf,
  onConvert,
}: {
  budget: CrmBudget;
  columnKey?: ColumnKey;
  busyId?: string | null;
  dragging?: boolean;
  handleProps?: Record<string, any>;
  className?: string;
  onEdit?: (b: CrmBudget) => void;
  onPdf?: (b: CrmBudget) => void;
  onConvert?: (b: CrmBudget) => void;
}) {
  const expired = isExpired(b);
  const busy = busyId === b.id;
  const open = b.status === "ABERTO" || b.status === "EXPIRADO";
  const col = columnKey ?? deriveColumn(b);
  const closed = col === "CANCELADO" || col === "PERDIDO";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_14px_40px_-34px_rgba(14,31,42,0.6)] transition-shadow hover:shadow-[0_18px_50px_-30px_rgba(14,31,42,0.55)]",
        closed && "opacity-[0.72]",
        dragging && "w-[264px] rotate-[0.8deg] shadow-xl",
        className,
      )}
    >
      {/* spine de cor à esquerda (paleta oficial) */}
      <span
        className={cn("absolute inset-y-0 left-0 w-1", COLUMN_ACCENT[col])}
        aria-hidden
      />

      <div className="py-2.5 pl-3.5 pr-2.5">
        <div className="flex items-start gap-1.5">
          {handleProps && (
            <button
              type="button"
              aria-label="Arrastar orçamento"
              className="-ml-1 mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
              {...handleProps}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-sm font-semibold text-foreground",
                FONT_DISPLAY,
              )}
            >
              {b.customer?.name || "—"}
            </p>
            <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {b.document || b.reason || "sem documento"}
            </p>
          </div>
          <span className="shrink-0 pt-0.5 text-right">
            <span className="block font-mono text-sm font-bold leading-none text-foreground">
              {formatToBRL(b.totalAmount)}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
              reais
            </span>
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {expired && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-orange-800 dark:bg-orange-900/40 dark:text-orange-200">
              <CalendarClock className="h-3 w-3" />
              expirado
            </span>
          )}
          {b.validUntil && !expired && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
              <CalendarClock className="h-3 w-3" />
              {new Date(b.validUntil).toLocaleDateString("pt-BR")}
            </span>
          )}
          {b.vendedor && (
            <span className="max-w-[130px] truncate rounded-full bg-muted px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
              {b.vendedor.name || b.vendedor.email}
            </span>
          )}
        </div>

        {closed && b.lostReason && (
          <p
            className={cn(
              "mt-2 line-clamp-2 text-[11px] italic text-muted-foreground",
              FONT_SERIF,
            )}
          >
            “{b.lostReason}”
          </p>
        )}

        {!dragging && (onEdit || onPdf || onConvert) && (
          <div className="mt-2 flex items-center justify-end gap-0.5 border-t border-dashed border-border/50 pt-1.5">
            {open && onConvert && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="Converter em venda (Conta a Receber)"
                disabled={busy}
                onClick={() => onConvert(b)}
              >
                <ShoppingCart className="h-3.5 w-3.5 text-[#2c5f4f] dark:text-emerald-400" />
              </Button>
            )}
            {onPdf && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="Imprimir orçamento (PDF)"
                disabled={busy}
                onClick={() => onPdf(b)}
              >
                <FileDown className="h-3.5 w-3.5" />
              </Button>
            )}
            {open && onEdit && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="Editar"
                disabled={busy}
                onClick={() => onEdit(b)}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Pencil className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
