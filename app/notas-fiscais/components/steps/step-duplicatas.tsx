"use client";

import {
  Control,
  Controller,
  FieldErrors,
  UseFormGetValues,
  useFieldArray,
} from "react-hook-form";
import { Plus, Trash2, Receipt } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
  getValues: UseFormGetValues<NfeDraftFormData>;
}

export function StepDuplicatas({ control, errors, getValues }: Props) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "duplicatas",
  });

  const addDuplicata = () => {
    const nextNum = fields.length + 1;
    // Default vencimento to 30 days from now
    const venc = new Date();
    venc.setDate(venc.getDate() + 30 * nextNum);
    append({
      numero: String(nextNum).padStart(3, "0"),
      vencimento: venc.toISOString().slice(0, 10),
      valor: 0,
    });
  };

  const totalDuplicatas = fields.reduce((sum, _, idx) => {
    const dups = getValues("duplicatas");
    return sum + (Number(dups[idx]?.valor) || 0);
  }, 0);

  const dupErrors = errors.duplicatas as any;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Duplicatas / Cobranca
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addDuplicata}
        >
          <Plus className="h-4 w-4 mr-1" />
          Adicionar duplicata
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-muted-foreground">
          <Receipt className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Nenhuma duplicata adicionada.</p>
          <p className="text-xs mt-1">
            Opcional — use para vendas a prazo com vencimentos.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((field, idx) => (
            <div
              key={field.id}
              className="rounded-lg border border-border/60 bg-card/40 p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-muted-foreground">
                  Duplicata {idx + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(idx)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Numero *</label>
                  <Controller
                    control={control}
                    name={`duplicatas.${idx}.numero`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="001"
                        className="h-8 text-sm"
                      />
                    )}
                  />
                  {dupErrors?.[idx]?.numero && (
                    <p className="text-xs text-destructive">
                      {dupErrors[idx].numero.message}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Vencimento *</label>
                  <Controller
                    control={control}
                    name={`duplicatas.${idx}.vencimento`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="date"
                        value={field.value ?? ""}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                  {dupErrors?.[idx]?.vencimento && (
                    <p className="text-xs text-destructive">
                      {dupErrors[idx].vencimento.message}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Valor (R$) *</label>
                  <Controller
                    control={control}
                    name={`duplicatas.${idx}.valor`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.01"
                        min={0}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                  {dupErrors?.[idx]?.valor && (
                    <p className="text-xs text-destructive">
                      {dupErrors[idx].valor.message}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="flex justify-end border-t border-border/60 pt-3">
            <div className="text-sm">
              <span className="text-muted-foreground">Total duplicatas: </span>
              <span className="font-semibold">
                R$ {totalDuplicatas.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
