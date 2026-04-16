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
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import { MODALIDADE_FRETE_LABELS } from "../../lib/nfe-defaults";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
}

export function StepFrete({ control, errors }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Modalidade do frete
        </h3>

        <div className="max-w-md">
          <Controller
            control={control}
            name="modalidadeFrete"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(MODALIDADE_FRETE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Transportadora (opcional)
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">CPF/CNPJ</label>
            <Controller
              control={control}
              name="transportadora.cpfCnpj"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                />
              )}
            />
          </div>

          <div className="md:col-span-2 space-y-1">
            <label className="text-sm font-medium">Nome / Razao Social</label>
            <Controller
              control={control}
              name="transportadora.nome"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Inscricao Estadual</label>
            <Controller
              control={control}
              name="transportadora.inscricaoEstadual"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Endereco</label>
            <Controller
              control={control}
              name="transportadora.endereco"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Municipio</label>
            <Controller
              control={control}
              name="transportadora.municipio"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                />
              )}
            />
          </div>

          <div className="space-y-1 max-w-[120px]">
            <label className="text-sm font-medium">UF</label>
            <Controller
              control={control}
              name="transportadora.uf"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="UF"
                  maxLength={2}
                />
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
