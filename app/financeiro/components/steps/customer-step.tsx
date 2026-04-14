"use client";

import { Control, Controller, FieldErrors } from "react-hook-form";
import { CustomerCombobox, CustomerOption } from "../shared/customer-combobox";
import { maskCpf } from "@/app/lib/masks";
import type { FinanceEntryFormData } from "../../lib/finance-schema";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
  selected: CustomerOption | null;
  onSelect: (c: CustomerOption) => void;
}

export function CustomerStep({ control, errors, selected, onSelect }: Props) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Selecione o cliente vinculado à conta. A busca é feita por nome ou CPF.
      </p>

      <Controller
        control={control}
        name="customerId"
        render={({ field }) => (
          <div className="space-y-1">
            <label className="text-sm font-medium">Cliente</label>
            <CustomerCombobox
              value={field.value || null}
              selectedLabel={selected?.name}
              onChange={(c) => {
                field.onChange(c.id);
                onSelect(c);
              }}
            />
            {errors.customerId && (
              <p className="text-xs text-destructive">
                {errors.customerId.message}
              </p>
            )}
          </div>
        )}
      />

      {selected && (
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
          <p className="text-xs uppercase text-muted-foreground">
            Cliente selecionado
          </p>
          <p className="text-sm font-medium">{selected.name}</p>
          <p className="text-xs text-muted-foreground">
            {selected.cpf ? maskCpf(selected.cpf) : "Sem CPF cadastrado"}
          </p>
        </div>
      )}
    </div>
  );
}
