"use client";

import { FileDown, Loader2, Pencil, ShoppingCart } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatToBRL } from "@/components/ui/currency-input";
import { cn } from "@/lib/utils";
import {
  COLUMN_LABEL,
  COLUMN_ORDER,
  COLUMN_STYLES,
  FONT_DISPLAY,
  type ColumnKey,
  type CrmBudget,
  deriveColumn,
  isExpired,
} from "./budget-crm-shared";

const TH =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";

interface Props {
  budgets: CrmBudget[];
  loading: boolean;
  busyId: string | null;
  onMove: (budgetId: string, to: ColumnKey) => void;
  onEdit: (b: CrmBudget) => void;
  onPdf: (b: CrmBudget) => void;
  onConvert: (b: CrmBudget) => void;
}

// Alternativa ao arrasto: um Select de Estágio por linha. Respeita a MESMA
// matriz (onMove) — mover para Fechado/Perdido/Cancelado abre confirmação no pai.
export function BudgetStageList({
  budgets,
  loading,
  busyId,
  onMove,
  onEdit,
  onPdf,
  onConvert,
}: Props) {
  return (
    <div className="rounded-xl border border-border/70 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={TH}>Cliente</TableHead>
            <TableHead className={TH}>Documento</TableHead>
            <TableHead className={TH}>Valor</TableHead>
            <TableHead className={TH}>Validade</TableHead>
            <TableHead className={TH}>Vendedor</TableHead>
            <TableHead className={cn(TH, "w-[200px]")}>Estágio</TableHead>
            <TableHead className={cn(TH, "text-right")}>Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {budgets.length === 0 && !loading && (
            <TableRow>
              <TableCell
                colSpan={7}
                className="text-center py-8 text-muted-foreground"
              >
                Nenhum orçamento encontrado.
              </TableCell>
            </TableRow>
          )}
          {budgets.map((b) => {
            const col = deriveColumn(b);
            const open = b.status === "ABERTO" || b.status === "EXPIRADO";
            const expired = isExpired(b);
            return (
              <TableRow key={b.id}>
                <TableCell className={cn("font-semibold", FONT_DISPLAY)}>
                  {b.customer?.name || "—"}
                </TableCell>
                <TableCell className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  {b.document || b.reason || "—"}
                </TableCell>
                <TableCell className="font-mono text-sm font-semibold">
                  {formatToBRL(b.totalAmount)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {b.validUntil ? (
                    <span
                      className={cn(
                        expired &&
                          "font-semibold text-orange-600 dark:text-orange-400",
                      )}
                    >
                      {new Date(b.validUntil).toLocaleDateString("pt-BR")}
                      {expired ? " · exp." : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {b.vendedor?.name || b.vendedor?.email || "—"}
                </TableCell>
                <TableCell>
                  {open ? (
                    <Select
                      value={col}
                      onValueChange={(v) => onMove(b.id, v as ColumnKey)}
                      disabled={busyId !== null}
                    >
                      <SelectTrigger className="h-9 rounded-full border border-border/70 bg-muted/20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* De um card aberto, todos os 6 destinos são válidos:
                            aberto↔aberto (stage), →Fechado (convert), →Perdido/
                            Cancelado (cancel). O pai (onMove) confirma/bloqueia. */}
                        {COLUMN_ORDER.map((k) => (
                          <SelectItem key={k} value={k}>
                            {COLUMN_LABEL[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
                        COLUMN_STYLES[col],
                      )}
                    >
                      {COLUMN_LABEL[col]}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex gap-1">
                    {open && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Converter em venda (Conta a Receber)"
                        disabled={busyId !== null}
                        onClick={() => onConvert(b)}
                      >
                        <ShoppingCart className="h-4 w-4 text-green-600" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Imprimir orçamento (PDF)"
                      disabled={busyId !== null}
                      onClick={() => onPdf(b)}
                    >
                      <FileDown className="h-4 w-4" />
                    </Button>
                    {open && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Editar"
                        disabled={busyId !== null}
                        onClick={() => onEdit(b)}
                      >
                        {busyId === b.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Pencil className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
