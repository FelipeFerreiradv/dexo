"use client";

import { useState } from "react";
import {
  Control,
  Controller,
  FieldErrors,
  UseFormSetValue,
  useWatch,
} from "react-hook-form";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { maskCpf, maskCnpj, onlyDigits } from "@/app/lib/masks";
import { fetchCompanyByCnpj } from "@/app/lib/cnpj-service";
import type { CustomerFormData } from "../../lib/customer-schema";

// Pessoa Jurídica de 1ª classe atrás de flag — off = layout PF atual (zero
// regressão; o seletor e os campos PJ nem aparecem).
const PJ_ENABLED = process.env.NEXT_PUBLIC_CUSTOMER_PJ_ENABLED === "true";

interface Props {
  control: Control<CustomerFormData>;
  errors: FieldErrors<CustomerFormData>;
  setValue: UseFormSetValue<CustomerFormData>;
}

export function IdentificationStep({ control, errors, setValue }: Props) {
  const personType = useWatch({ control, name: "personType" }) ?? "PF";
  const showPj = PJ_ENABLED && personType === "PJ";
  const [loadingCnpj, setLoadingCnpj] = useState(false);

  const handleCnpjLookup = async (raw: string) => {
    const clean = onlyDigits(raw);
    if (clean.length !== 14) return;
    setLoadingCnpj(true);
    try {
      const c = await fetchCompanyByCnpj(clean);
      if (!c) return;
      if (c.razaoSocial)
        setValue("razaoSocial", c.razaoSocial, {
          shouldDirty: true,
          shouldValidate: true,
        });
      if (c.nomeFantasia)
        setValue("nomeFantasia", c.nomeFantasia, { shouldDirty: true });
      if (c.cep) setValue("cep", c.cep, { shouldDirty: true });
      if (c.street) setValue("street", c.street, { shouldDirty: true });
      if (c.number) setValue("number", c.number, { shouldDirty: true });
      if (c.neighborhood)
        setValue("neighborhood", c.neighborhood, { shouldDirty: true });
      if (c.city) setValue("city", c.city, { shouldDirty: true });
      if (c.state) setValue("state", c.state, { shouldDirty: true });
    } finally {
      setLoadingCnpj(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {PJ_ENABLED && (
        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">Tipo de pessoa *</label>
          <Controller
            control={control}
            name="personType"
            render={({ field }) => (
              <Select
                value={field.value ?? "PF"}
                onValueChange={(v) => field.onChange(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PF">Pessoa Física (CPF)</SelectItem>
                  <SelectItem value="PJ">Pessoa Jurídica (CNPJ)</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>
      )}

      {showPj ? (
        <>
          <div className="md:col-span-2 space-y-1">
            <label className="text-sm font-medium">CNPJ *</label>
            <div className="relative flex gap-2">
              <div className="relative flex-1">
                <Controller
                  control={control}
                  name="cnpj"
                  render={({ field }) => (
                    <Input
                      {...field}
                      value={maskCnpj(field.value ?? "")}
                      onChange={(e) => field.onChange(maskCnpj(e.target.value))}
                      onBlur={(e) => {
                        field.onBlur();
                        handleCnpjLookup(e.target.value);
                      }}
                      placeholder="00.000.000/0000-00"
                      inputMode="numeric"
                    />
                  )}
                />
                {loadingCnpj && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
              <Controller
                control={control}
                name="cnpj"
                render={({ field }) => (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loadingCnpj}
                    onClick={() => handleCnpjLookup(field.value ?? "")}
                    title="Buscar dados pelo CNPJ"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                )}
              />
            </div>
            {errors.cnpj && (
              <p className="text-xs text-destructive">{errors.cnpj.message}</p>
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
                  placeholder="Razão social da empresa"
                />
              )}
            />
            {errors.razaoSocial && (
              <p className="text-xs text-destructive">
                {errors.razaoSocial.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Nome fantasia</label>
            <Controller
              control={control}
              name="nomeFantasia"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  placeholder="Opcional"
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Inscrição estadual</label>
            <Controller
              control={control}
              name="inscricaoEstadual"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  placeholder="ISENTO ou número"
                />
              )}
            />
          </div>

          <div className="md:col-span-2 space-y-1">
            <label className="text-sm font-medium">Indicador de IE</label>
            <Controller
              control={control}
              name="indicadorIE"
              render={({ field }) => (
                <Select
                  value={field.value ?? "9"}
                  onValueChange={(v) => field.onChange(v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 - Contribuinte de ICMS</SelectItem>
                    <SelectItem value="2">2 - Contribuinte isento</SelectItem>
                    <SelectItem value="9">9 - Não contribuinte</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </>
      ) : (
        <>
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
                <Input type="date" {...field} value={field.value ?? ""} />
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
        </>
      )}
    </div>
  );
}
