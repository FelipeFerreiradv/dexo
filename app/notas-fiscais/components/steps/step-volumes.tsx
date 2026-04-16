"use client";

import {
  Control,
  Controller,
  FieldErrors,
  useFieldArray,
} from "react-hook-form";
import { Plus, Trash2, Box } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import { ESPECIE_VOLUME_OPTIONS } from "../../lib/nfe-defaults";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
}

export function StepVolumes({ control, errors }: Props) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "volumes",
  });

  const addVolume = () => {
    append({
      quantidade: 1,
      especie: "VOLUME",
      marca: null,
      numeracao: null,
      pesoLiquido: null,
      pesoBruto: null,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Volumes da nota
        </h3>
        <Button type="button" variant="outline" size="sm" onClick={addVolume}>
          <Plus className="h-4 w-4 mr-1" />
          Adicionar volume
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-muted-foreground">
          <Box className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Nenhum volume adicionado.</p>
          <p className="text-xs mt-1">
            Opcional — preencha se a nota envolve transporte fisico.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((field, idx) => (
            <div
              key={field.id}
              className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  Volume {idx + 1}
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

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Quantidade</label>
                  <Controller
                    control={control}
                    name={`volumes.${idx}.quantidade`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        min={0}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value ? Number(e.target.value) : null,
                          )
                        }
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Especie</label>
                  <Controller
                    control={control}
                    name={`volumes.${idx}.especie`}
                    render={({ field }) => (
                      <>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(e.target.value || null)
                          }
                          placeholder="Ex: CAIXA, VOLUME..."
                          list={`especie-options-${idx}`}
                          className="h-8 text-sm"
                        />
                        <datalist id={`especie-options-${idx}`}>
                          {ESPECIE_VOLUME_OPTIONS.map((opt) => (
                            <option key={opt} value={opt} />
                          ))}
                        </datalist>
                      </>
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Marca</label>
                  <Controller
                    control={control}
                    name={`volumes.${idx}.marca`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value || null)}
                        placeholder="Opcional"
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Numeracao</label>
                  <Controller
                    control={control}
                    name={`volumes.${idx}.numeracao`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value || null)}
                        placeholder="Opcional"
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Peso liquido (kg)</label>
                  <Controller
                    control={control}
                    name={`volumes.${idx}.pesoLiquido`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.001"
                        min={0}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value ? Number(e.target.value) : null,
                          )
                        }
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Peso bruto (kg)</label>
                  <Controller
                    control={control}
                    name={`volumes.${idx}.pesoBruto`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.001"
                        min={0}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value ? Number(e.target.value) : null,
                          )
                        }
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
