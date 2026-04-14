"use client";

import { Control, Controller, FieldErrors } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput } from "@/components/ui/currency-input";
import type { FinanceEntryFormData } from "../../lib/finance-schema";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
}

export function TitleStep({ control, errors }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="space-y-1">
        <label className="text-sm font-medium">Nº do documento</label>
        <Controller
          control={control}
          name="document"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Ex: NF 1234"
            />
          )}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Motivo</label>
        <Controller
          control={control}
          name="reason"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Ex: Venda de peças"
            />
          )}
        />
      </div>

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium">Detalhes da dívida</label>
        <Controller
          control={control}
          name="debtDetails"
          render={({ field }) => (
            <Textarea
              {...field}
              value={field.value ?? ""}
              placeholder="Descrição adicional do título..."
              rows={3}
            />
          )}
        />
      </div>

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium">Valor total *</label>
        <Controller
          control={control}
          name="totalAmount"
          render={({ field }) => (
            <CurrencyInput
              value={field.value}
              onChange={(v) => field.onChange(v ?? 0)}
            />
          )}
        />
        {errors.totalAmount && (
          <p className="text-xs text-destructive">
            {errors.totalAmount.message}
          </p>
        )}
      </div>
    </div>
  );
}
