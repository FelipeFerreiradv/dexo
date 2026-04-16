"use client";

import { Control, Controller, FieldErrors } from "react-hook-form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { maskCnpj } from "@/app/lib/masks";
import type { FiscalConfigFormData } from "../../lib/fiscal-config-schema";

interface Props {
  control: Control<FiscalConfigFormData>;
  errors: FieldErrors<FiscalConfigFormData>;
}

export function FiscalIdentificationStep({ control, errors }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="space-y-1">
        <label className="text-sm font-medium">CNPJ *</label>
        <Controller
          control={control}
          name="cnpj"
          render={({ field }) => (
            <Input
              {...field}
              value={maskCnpj(field.value ?? "")}
              onChange={(e) => field.onChange(maskCnpj(e.target.value))}
              placeholder="00.000.000/0000-00"
              inputMode="numeric"
            />
          )}
        />
        {errors.cnpj && (
          <p className="text-xs text-destructive">{errors.cnpj.message}</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Regime tributário *</label>
        <Controller
          control={control}
          name="regimeTributario"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SIMPLES">Simples Nacional</SelectItem>
                <SelectItem value="LUCRO_PRESUMIDO">Lucro Presumido</SelectItem>
                <SelectItem value="LUCRO_REAL">Lucro Real</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        {errors.regimeTributario && (
          <p className="text-xs text-destructive">
            {errors.regimeTributario.message}
          </p>
        )}
      </div>

      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">Razão social *</label>
        <Controller
          control={control}
          name="razaoSocial"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Razão social do emissor"
            />
          )}
        />
        {errors.razaoSocial && (
          <p className="text-xs text-destructive">
            {errors.razaoSocial.message}
          </p>
        )}
      </div>

      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">Nome fantasia</label>
        <Controller
          control={control}
          name="nomeFantasia"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Inscrição estadual *</label>
        <Controller
          control={control}
          name="inscricaoEstadual"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Somente números ou ISENTO"
            />
          )}
        />
        {errors.inscricaoEstadual && (
          <p className="text-xs text-destructive">
            {errors.inscricaoEstadual.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Inscrição municipal</label>
        <Controller
          control={control}
          name="inscricaoMunicipal"
          render={({ field }) => (
            <Input {...field} value={field.value ?? ""} />
          )}
        />
      </div>

      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">CNAE</label>
        <Controller
          control={control}
          name="cnae"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Ex: 4530703"
            />
          )}
        />
      </div>
    </div>
  );
}
