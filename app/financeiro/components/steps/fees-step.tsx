"use client";

import { Control, Controller, FieldErrors } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import type { FinanceEntryFormData } from "../../lib/finance-schema";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
}

function PercentInput({
  value,
  onChange,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="relative">
      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min={0}
        max={100}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : Number(v));
        }}
        className="pr-8"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        %
      </span>
    </div>
  );
}

export function FeesStep({ control, errors }: Props) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Encargos opcionais. Use porcentagem ou valor fixo para multa.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Multa (valor fixo)</label>
          <Controller
            control={control}
            name="fineAmount"
            render={({ field }) => (
              <CurrencyInput
                value={field.value}
                onChange={(v) => field.onChange(v)}
              />
            )}
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Multa (%)</label>
          <Controller
            control={control}
            name="finePercent"
            render={({ field }) => (
              <PercentInput value={field.value} onChange={field.onChange} />
            )}
          />
          {errors.finePercent && (
            <p className="text-xs text-destructive">
              {errors.finePercent.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Juros ao mês (%)</label>
          <Controller
            control={control}
            name="interestPercent"
            render={({ field }) => (
              <PercentInput value={field.value} onChange={field.onChange} />
            )}
          />
          {errors.interestPercent && (
            <p className="text-xs text-destructive">
              {errors.interestPercent.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Tolerância (dias)</label>
          <Controller
            control={control}
            name="toleranceDays"
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
              />
            )}
          />
          {errors.toleranceDays && (
            <p className="text-xs text-destructive">
              {errors.toleranceDays.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
