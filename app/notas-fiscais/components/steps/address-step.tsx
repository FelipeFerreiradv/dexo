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
import type { FiscalConfigFormData } from "../../lib/fiscal-config-schema";

interface Props {
  control: Control<FiscalConfigFormData>;
  errors: FieldErrors<FiscalConfigFormData>;
  setValue: UseFormSetValue<FiscalConfigFormData>;
}

export function FiscalAddressStep({ control, errors, setValue }: Props) {
  const [loadingCep, setLoadingCep] = useState(false);

  const handleCepBlur = async (raw: string) => {
    const clean = onlyDigits(raw);
    if (clean.length !== 8) return;
    setLoadingCep(true);
    try {
      const addr = await fetchAddressByCep(clean);
      if (addr) {
        setValue("logradouro", addr.street, { shouldDirty: true });
        setValue("bairro", addr.neighborhood, { shouldDirty: true });
        setValue("municipio", addr.city, { shouldDirty: true });
        setValue("uf", addr.state, { shouldDirty: true });
        setValue("codMunicipio", addr.ibge, { shouldDirty: true });
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
          name="logradouro"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="md:col-span-1 space-y-1">
        <label className="text-sm font-medium">Número</label>
        <Controller
          control={control}
          name="numero"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} placeholder="000" />
          )}
        />
      </div>

      <div className="md:col-span-3 space-y-1">
        <label className="text-sm font-medium">Complemento</label>
        <Controller
          control={control}
          name="complemento"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">Bairro</label>
        <Controller
          control={control}
          name="bairro"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="md:col-span-3 space-y-1">
        <label className="text-sm font-medium">Município</label>
        <Controller
          control={control}
          name="municipio"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="md:col-span-1 space-y-1">
        <label className="text-sm font-medium">UF</label>
        <Controller
          control={control}
          name="uf"
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
        {errors.uf && (
          <p className="text-xs text-destructive">{errors.uf.message}</p>
        )}
      </div>

      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">Código IBGE município</label>
        <Controller
          control={control}
          name="codMunicipio"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Ex: 3550308"
            />
          )}
        />
      </div>
    </div>
  );
}
