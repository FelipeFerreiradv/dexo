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
import { maskCpf } from "@/app/lib/masks";
import type { CustomerFormData } from "../../lib/customer-schema";

interface Props {
  control: Control<CustomerFormData>;
  errors: FieldErrors<CustomerFormData>;
}

export function IdentificationStep({ control, errors }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">Nome completo *</label>
        <Controller
          control={control}
          name="name"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Nome completo do cliente"
            />
          )}
        />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">CPF</label>
        <Controller
          control={control}
          name="cpf"
          render={({ field }) => (
            <Input
              {...field}
              value={maskCpf(field.value ?? "")}
              onChange={(e) => field.onChange(maskCpf(e.target.value))}
              placeholder="000.000.000-00"
              inputMode="numeric"
            />
          )}
        />
        {errors.cpf && (
          <p className="text-xs text-destructive">{errors.cpf.message}</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">RG</label>
        <Controller
          control={control}
          name="rg"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="00.000.000-0"
            />
          )}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Data de nascimento</label>
        <Controller
          control={control}
          name="birthDate"
          render={({ field }) => (
            <Input
              type="date"
              {...field}
              value={field.value ?? ""}
            />
          )}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Sexo</label>
        <Controller
          control={control}
          name="gender"
          render={({ field }) => (
            <Select
              value={field.value ?? ""}
              onValueChange={(v) => field.onChange(v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="M">Masculino</SelectItem>
                <SelectItem value="F">Feminino</SelectItem>
                <SelectItem value="OUTRO">Outro</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium">Estado civil</label>
        <Controller
          control={control}
          name="maritalStatus"
          render={({ field }) => (
            <Select
              value={field.value ?? ""}
              onValueChange={(v) => field.onChange(v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SOLTEIRO">Solteiro(a)</SelectItem>
                <SelectItem value="CASADO">Casado(a)</SelectItem>
                <SelectItem value="DIVORCIADO">Divorciado(a)</SelectItem>
                <SelectItem value="VIUVO">Viúvo(a)</SelectItem>
                <SelectItem value="UNIAO_ESTAVEL">União estável</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>
    </div>
  );
}
