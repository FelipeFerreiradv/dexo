"use client";

import { useState } from "react";
import {
  Control,
  Controller,
  FieldErrors,
  UseFormSetValue,
} from "react-hook-form";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { maskCep, onlyDigits } from "@/app/lib/masks";
import { fetchAddressByCep } from "@/app/lib/cep-service";
import type { CustomerFormData } from "../../lib/customer-schema";

interface Props {
  control: Control<CustomerFormData>;
  errors: FieldErrors<CustomerFormData>;
  setValue: UseFormSetValue<CustomerFormData>;
}

export function AddressStep({ control, errors, setValue }: Props) {
  const [loadingCep, setLoadingCep] = useState(false);

  const handleCepBlur = async (raw: string) => {
    const clean = onlyDigits(raw);
    if (clean.length !== 8) return;
    setLoadingCep(true);
    try {
      const addr = await fetchAddressByCep(clean);
      if (addr) {
        setValue("street", addr.street, { shouldDirty: true });
        setValue("neighborhood", addr.neighborhood, { shouldDirty: true });
        setValue("city", addr.city, { shouldDirty: true });
        setValue("state", addr.state, { shouldDirty: true });
        setValue("ibge", addr.ibge, { shouldDirty: true });
      }
    } finally {
      setLoadingCep(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">CEP</label>
        <div className="relative">
          <Controller
            control={control}
            name="cep"
            render={({ field }) => (
              <Input
                {...field}
                value={maskCep(field.value ?? "")}
                onChange={(e) => field.onChange(maskCep(e.target.value))}
                onBlur={(e) => {
                  field.onBlur();
                  handleCepBlur(e.target.value);
                }}
                placeholder="00000-000"
                inputMode="numeric"
              />
            )}
          />
          {loadingCep && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        {errors.cep && (
          <p className="text-xs text-destructive">{errors.cep.message}</p>
        )}
      </div>

      <div className="md:col-span-4 space-y-1">
        <label className="text-sm font-medium">Logradouro</label>
        <Controller
          control={control}
          name="street"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Rua / Avenida"
            />
          )}
        />
      </div>

      <div className="md:col-span-1 space-y-1">
        <label className="text-sm font-medium">Número</label>
        <Controller
          control={control}
          name="number"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} placeholder="000" />
          )}
        />
      </div>

      <div className="md:col-span-3 space-y-1">
        <label className="text-sm font-medium">Complemento</label>
        <Controller
          control={control}
          name="complement"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Apto, bloco, sala..."
            />
          )}
        />
      </div>

      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">Bairro</label>
        <Controller
          control={control}
          name="neighborhood"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="md:col-span-3 space-y-1">
        <label className="text-sm font-medium">Cidade</label>
        <Controller
          control={control}
          name="city"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="md:col-span-1 space-y-1">
        <label className="text-sm font-medium">UF</label>
        <Controller
          control={control}
          name="state"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              maxLength={2}
              onChange={(e) => field.onChange(e.target.value.toUpperCase())}
              placeholder="UF"
            />
          )}
        />
        {errors.state && (
          <p className="text-xs text-destructive">{errors.state.message}</p>
        )}
      </div>

      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">IBGE</label>
        <Controller
          control={control}
          name="ibge"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Código IBGE"
            />
          )}
        />
      </div>

      <div className="md:col-span-4 space-y-1">
        <label className="text-sm font-medium">Referência</label>
        <Controller
          control={control}
          name="reference"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Próximo à..."
            />
          )}
        />
      </div>
    </div>
  );
}
