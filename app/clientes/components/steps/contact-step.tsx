"use client";

import { Control, Controller, FieldErrors } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { maskPhone } from "@/app/lib/masks";
import type { CustomerFormData } from "../../lib/customer-schema";

interface Props {
  control: Control<CustomerFormData>;
  errors: FieldErrors<CustomerFormData>;
}

export function ContactStep({ control, errors }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="md:col-span-2 space-y-1">
        <label className="text-sm font-medium">E-mail</label>
        <Controller
          control={control}
          name="email"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              type="email"
              placeholder="cliente@email.com"
            />
          )}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Telefone</label>
        <Controller
          control={control}
          name="phone"
          render={({ field }) => (
            <Input
              {...field}
              value={maskPhone(field.value ?? "")}
              onChange={(e) => field.onChange(maskPhone(e.target.value))}
              placeholder="(00) 0000-0000"
              inputMode="numeric"
            />
          )}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Celular</label>
        <Controller
          control={control}
          name="mobile"
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
    </div>
  );
}
