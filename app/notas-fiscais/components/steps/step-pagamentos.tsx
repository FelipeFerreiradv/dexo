"use client";

import {
  Control,
  Controller,
  FieldErrors,
  UseFormGetValues,
  useFieldArray,
} from "react-hook-form";
import { Plus, Trash2, CreditCard } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import { MEIO_PAGAMENTO_LABELS } from "../../lib/nfe-defaults";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
  getValues: UseFormGetValues<NfeDraftFormData>;
}

export function StepPagamentos({ control, errors, getValues }: Props) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "pagamentos",
  });

  const addPagamento = () => {
    append({ meio: "DINHEIRO", valor: 0 });
  };

  const totalPagamentos = fields.reduce((sum, _, idx) => {
    const pags = getValues("pagamentos");
    return sum + (Number(pags[idx]?.valor) || 0);
  }, 0);

  const totalProdutos = (getValues("itens") ?? []).reduce(
    (sum, item) => sum + (Number(item.valorTotal) || 0),
    0,
  );

  const diff = totalProdutos - totalPagamentos;

  const pagErrors = errors.pagamentos as any;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Formas de pagamento
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addPagamento}
        >
          <Plus className="h-4 w-4 mr-1" />
          Adicionar pagamento
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-muted-foreground">
          <CreditCard className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Nenhuma forma de pagamento.</p>
          <p className="text-xs mt-1">
            Adicione pelo menos uma forma de pagamento.
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
                  Pagamento {idx + 1}
                </span>
                {fields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(idx)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium">
                    Meio de pagamento *
                  </label>
                  <Controller
                    control={control}
                    name={`pagamentos.${idx}.meio`}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(MEIO_PAGAMENTO_LABELS).map(
                            ([k, v]) => (
                              <SelectItem key={k} value={k}>
                                {v}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Valor (R$) *</label>
                  <Controller
                    control={control}
                    name={`pagamentos.${idx}.valor`}
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
                  {pagErrors?.[idx]?.valor && (
                    <p className="text-xs text-destructive">
                      {pagErrors[idx].valor.message}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="flex justify-end gap-6 border-t border-border/60 pt-3">
            <div className="text-sm">
              <span className="text-muted-foreground">Total produtos: </span>
              <span className="font-semibold">
                R$ {totalProdutos.toFixed(2)}
              </span>
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">Total pagamentos: </span>
              <span className="font-semibold">
                R$ {totalPagamentos.toFixed(2)}
              </span>
            </div>
            {Math.abs(diff) > 0.01 && (
              <div className="text-sm text-amber-600">
                Diferenca: R$ {diff.toFixed(2)}
              </div>
            )}
          </div>
        </div>
      )}

      {pagErrors?.message && (
        <p className="text-xs text-destructive">{pagErrors.message}</p>
      )}
      {pagErrors?.root?.message && (
        <p className="text-xs text-destructive">{pagErrors.root.message}</p>
      )}
    </div>
  );
}
