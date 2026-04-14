"use client";

import { Control, Controller, FieldErrors, useWatch } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { formatToBRL } from "@/components/ui/currency-input";
import type { FinanceEntryFormData } from "../../lib/finance-schema";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
}

export function InstallmentsStep({ control, errors }: Props) {
  const values = useWatch({ control });
  const installments = values.installments || 1;
  const total = values.totalAmount || 0;
  const perInstallment = total / installments;
  const periodDays = values.periodDays ?? 30;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">Nº de parcelas *</label>
          <Controller
            control={control}
            name="installments"
            render={({ field }) => (
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={360}
                value={field.value ?? 1}
                onChange={(e) =>
                  field.onChange(Number(e.target.value) || 1)
                }
              />
            )}
          />
          {errors.installments && (
            <p className="text-xs text-destructive">
              {errors.installments.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Período (dias)</label>
          <Controller
            control={control}
            name="periodDays"
            render={({ field }) => (
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={field.value ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  field.onChange(v === "" ? null : Number(v));
                }}
                placeholder="30"
              />
            )}
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">1º vencimento *</label>
          <Controller
            control={control}
            name="dueDate"
            render={({ field }) => (
              <Input
                type="date"
                value={field.value ?? ""}
                onChange={field.onChange}
              />
            )}
          />
          {errors.dueDate && (
            <p className="text-xs text-destructive">
              {errors.dueDate.message}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
        <p className="text-xs uppercase text-muted-foreground">Resumo</p>
        <div className="grid grid-cols-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">Valor total:</span>
          <span className="text-right font-medium">
            R$ {formatToBRL(total)}
          </span>
          <span className="text-muted-foreground">Parcelas:</span>
          <span className="text-right font-medium">
            {installments}x de R$ {formatToBRL(perInstallment)}
          </span>
          <span className="text-muted-foreground">Intervalo:</span>
          <span className="text-right font-medium">{periodDays} dia(s)</span>
        </div>
      </div>
    </div>
  );
}
