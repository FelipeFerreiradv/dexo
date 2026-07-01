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
  COLUMN_LABEL,
  COLUMN_ORDER,
  COLUMN_STYLES,
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
      <div className="flex gap-4 overflow-x-auto pb-3 [scrollbar-width:thin]">
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
        "flex w-[280px] shrink-0 flex-col rounded-2xl border border-border/60 bg-muted/15 transition-colors",
        isOver && "border-primary/60 bg-primary/5",
      )}
    >
      <div className={cn("h-1 rounded-t-2xl", COLUMN_ACCENT[columnKey])} />
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
            COLUMN_STYLES[columnKey],
          )}
        >
          {COLUMN_LABEL[columnKey]}
        </span>
        <span className="text-[11px] font-semibold text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="px-3 pb-1 text-[11px] text-muted-foreground">
        R$ {formatToBRL(total)}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-2">
        {items.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/50 px-3 py-6 text-center text-[11px] text-muted-foreground">
            Sem orçamentos
          </div>
        )}
        {items.map((b) => (
          <DraggableCard
            key={b.id}
            budget={b}
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
  draggable,
  busyId,
  onEdit,
  onPdf,
  onConvert,
}: {
  budget: CrmBudget;
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
        busyId={busyId}
        handleProps={draggable ? { ...listeners, ...attributes } : undefined}
        onEdit={onEdit}
        onPdf={onPdf}
        onConvert={onConvert}
      />
    </div>
  );
}

// Cartão (identidade Dexo). Reutilizado no DragOverlay (dragging) e nas colunas.
function CardShell({
  budget: b,
  busyId,
  dragging,
  handleProps,
  className,
  onEdit,
  onPdf,
  onConvert,
}: {
  budget: CrmBudget;
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

  return (
    <div
      className={cn(
        "group rounded-xl border border-border/60 bg-card/80 p-3 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur",
        dragging && "w-[264px] rotate-1 shadow-lg",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {handleProps && (
          <button
            type="button"
            aria-label="Arrastar orçamento"
            className="mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/70 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
            {...handleProps}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {b.customer?.name || "—"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {b.document || b.reason || "Orçamento"}
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold">
          R$ {formatToBRL(b.totalAmount)}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {expired && (
          <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-800 dark:bg-orange-900/40 dark:text-orange-200">
            <CalendarClock className="h-3 w-3" />
            Expirado
          </span>
        )}
        {b.validUntil && !expired && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            <CalendarClock className="h-3 w-3" />
            {new Date(b.validUntil).toLocaleDateString("pt-BR")}
          </span>
        )}
        {b.vendedor && (
          <span className="truncate rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {b.vendedor.name || b.vendedor.email}
          </span>
        )}
      </div>

      {b.status === "CANCELADO" && b.lostReason && (
        <p className="mt-2 line-clamp-2 text-[11px] italic text-muted-foreground">
          {b.lostReason}
        </p>
      )}

      {!dragging && (onEdit || onPdf || onConvert) && (
        <div className="mt-2.5 flex items-center justify-end gap-0.5 border-t border-border/50 pt-2">
          {open && onConvert && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Converter em venda (Conta a Receber)"
              disabled={busy}
              onClick={() => onConvert(b)}
            >
              <ShoppingCart className="h-3.5 w-3.5 text-green-600" />
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
  );
}
