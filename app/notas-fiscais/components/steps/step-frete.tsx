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
import { CurrencyInput } from "@/components/ui/currency-input";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import { MODALIDADE_FRETE_LABELS } from "../../lib/nfe-defaults";

// Kill-switch da entrega de frete/medidas. Desligada, a etapa volta a ser
// exatamente a de antes. NEXT_PUBLIC_* e embutida no build — trocar exige
// `npm run build`, nao basta reiniciar o processo.
const FRETE_MEDIDAS_ENABLED =
  process.env.NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED === "true";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
}

export function StepFrete({ control, errors }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          {FRETE_MEDIDAS_ENABLED ? "Frete" : "Modalidade do frete"}
        </h3>

        <div
          className={
            FRETE_MEDIDAS_ENABLED
              ? "grid grid-cols-1 gap-4 md:grid-cols-2 md:max-w-2xl"
              : "max-w-md"
          }
        >
          <div className={FRETE_MEDIDAS_ENABLED ? "space-y-1" : undefined}>
            {FRETE_MEDIDAS_ENABLED && (
              <label className="text-sm font-medium">Modalidade</label>
            )}
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

          {FRETE_MEDIDAS_ENABLED && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Valor do frete</label>
              <Controller
                control={control}
                name="valorFrete"
                render={({ field, fieldState }) => (
                  <>
                    <CurrencyInput
                      ref={field.ref}
                      name={field.name}
                      value={field.value ?? null}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                    />
                    {fieldState.error ? (
                      <p className="text-sm text-destructive">
                        {fieldState.error.message}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Somado ao total da nota e rateado entre os itens.
                      </p>
                    )}
                  </>
                )}
              />
            </div>
          )}
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
