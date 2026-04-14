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
import { maskCep, maskCnpj, maskCpf, maskPhone, onlyDigits } from "@/app/lib/masks";
import { fetchAddressByCep } from "@/app/lib/cep-service";
import type { CustomerFormData } from "../../lib/customer-schema";

interface Props {
  control: Control<CustomerFormData>;
  errors: FieldErrors<CustomerFormData>;
  setValue: UseFormSetValue<CustomerFormData>;
}

export function DeliveryStep({ control, errors, setValue }: Props) {
  const [loadingCep, setLoadingCep] = useState(false);

  const handleDeliveryCepBlur = async (raw: string) => {
    const clean = onlyDigits(raw);
    if (clean.length !== 8) return;
    setLoadingCep(true);
    try {
      const addr = await fetchAddressByCep(clean);
      if (addr) {
        setValue("deliveryStreet", addr.street, { shouldDirty: true });
        setValue("deliveryNeighborhood", addr.neighborhood, {
          shouldDirty: true,
        });
        setValue("deliveryCity", addr.city, { shouldDirty: true });
        setValue("deliveryState", addr.state, { shouldDirty: true });
      }
    } finally {
      setLoadingCep(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Opcional. Preencha se o endereço de entrega for diferente do principal
        ou se o cliente for pessoa jurídica.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
        <div className="md:col-span-3 space-y-1">
          <label className="text-sm font-medium">Nome / Contato</label>
          <Controller
            control={control}
            name="deliveryName"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-3 space-y-1">
          <label className="text-sm font-medium">Razão social</label>
          <Controller
            control={control}
            name="deliveryCorporateName"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">CPF</label>
          <Controller
            control={control}
            name="deliveryCpf"
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
          {errors.deliveryCpf && (
            <p className="text-xs text-destructive">
              {errors.deliveryCpf.message}
            </p>
          )}
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">CNPJ</label>
          <Controller
            control={control}
            name="deliveryCnpj"
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
          {errors.deliveryCnpj && (
            <p className="text-xs text-destructive">
              {errors.deliveryCnpj.message}
            </p>
          )}
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">RG</label>
          <Controller
            control={control}
            name="deliveryRg"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">CEP</label>
          <div className="relative">
            <Controller
              control={control}
              name="deliveryCep"
              render={({ field }) => (
                <Input
                  {...field}
                  value={maskCep(field.value ?? "")}
                  onChange={(e) => field.onChange(maskCep(e.target.value))}
                  onBlur={(e) => {
                    field.onBlur();
                    handleDeliveryCepBlur(e.target.value);
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
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">Telefone</label>
          <Controller
            control={control}
            name="deliveryPhone"
            render={({ field }) => (
              <Input
                {...field}
                value={maskPhone(field.value ?? "")}
                onChange={(e) => field.onChange(maskPhone(e.target.value))}
                placeholder="(00) 00000-0000"
                inputMode="numeric"
              />
            )}
          />
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">Cidade</label>
          <Controller
            control={control}
            name="deliveryCity"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">Bairro</label>
          <Controller
            control={control}
            name="deliveryNeighborhood"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-1 space-y-1">
          <label className="text-sm font-medium">UF</label>
          <Controller
            control={control}
            name="deliveryState"
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ""}
                maxLength={2}
                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
              />
            )}
          />
        </div>

        <div className="md:col-span-4 space-y-1">
          <label className="text-sm font-medium">Logradouro</label>
          <Controller
            control={control}
            name="deliveryStreet"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-1 space-y-1">
          <label className="text-sm font-medium">Número</label>
          <Controller
            control={control}
            name="deliveryNumber"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-6 space-y-1">
          <label className="text-sm font-medium">Complemento</label>
          <Controller
            control={control}
            name="deliveryComplement"
            render={({ field }) => (
              <Input {...field} value={field.value ?? ""} />
            )}
          />
        </div>

        <div className="md:col-span-6 space-y-1">
          <label className="text-sm font-medium">Observações</label>
          <Controller
            control={control}
            name="notes"
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ""}
                placeholder="Observações adicionais sobre o cliente"
              />
            )}
          />
        </div>
      </div>
    </div>
  );
}
