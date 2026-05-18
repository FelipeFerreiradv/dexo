"use client";

import {
  Control,
  Controller,
  FieldErrors,
  UseFormSetValue,
  useWatch,
} from "react-hook-form";
import { UserPlus } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CustomerCombobox, CustomerOption } from "../shared/customer-combobox";
import { maskCpf } from "@/app/lib/masks";
import type { FinanceEntryFormData } from "../../lib/finance-schema";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
  selected: CustomerOption | null;
  onSelect: (c: CustomerOption) => void;
  setValue: UseFormSetValue<FinanceEntryFormData>;
  // Cadastro rápido só faz sentido ao CRIAR conta. Na edição o fluxo é
  // exatamente o de antes (sem o switch).
  allowQuickCreate: boolean;
}

export function CustomerStep({
  control,
  errors,
  selected,
  onSelect,
  setValue,
  allowQuickCreate,
}: Props) {
  const quick = useWatch({ control, name: "quickCreateCustomer" }) === true;
  const isQuick = allowQuickCreate && quick;

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
              disabled={isQuick}
              onChange={(c) => {
                field.onChange(c.id);
                onSelect(c);
              }}
            />
            {!isQuick && errors.customerId && (
              <p className="text-xs text-destructive">
                {errors.customerId.message}
              </p>
            )}
          </div>
        )}
      />

      {!isQuick && selected && (
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

      {allowQuickCreate && (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background">
                <UserPlus className="size-4 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Cadastrar novo cliente</p>
                <p className="text-xs text-muted-foreground">
                  Cria um cliente novo junto com esta conta. Os demais dados
                  podem ser preenchidos depois na aba Clientes.
                </p>
              </div>
            </div>
            <Controller
              control={control}
              name="quickCreateCustomer"
              render={({ field }) => (
                <Switch
                  checked={field.value === true}
                  onCheckedChange={(checked) => {
                    field.onChange(checked);
                    if (!checked) {
                      // Desligar: limpa os campos inline e restaura o
                      // fluxo de seleção (cliente/seleção anteriores
                      // permanecem intactos).
                      setValue("newCustomerName", "");
                      setValue("newCustomerCpf", "");
                    }
                  }}
                  aria-label="Cadastrar novo cliente"
                />
              )}
            />
          </div>

          {isQuick && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">Nome *</label>
                <Controller
                  control={control}
                  name="newCustomerName"
                  render={({ field }) => (
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      placeholder="Nome do cliente"
                      autoFocus
                    />
                  )}
                />
                {errors.newCustomerName && (
                  <p className="text-xs text-destructive">
                    {errors.newCustomerName.message}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">CPF</label>
                <Controller
                  control={control}
                  name="newCustomerCpf"
                  render={({ field }) => (
                    <Input
                      value={maskCpf(field.value ?? "")}
                      onChange={(e) => field.onChange(maskCpf(e.target.value))}
                      placeholder="000.000.000-00"
                      inputMode="numeric"
                    />
                  )}
                />
                {errors.newCustomerCpf && (
                  <p className="text-xs text-destructive">
                    {errors.newCustomerCpf.message}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
