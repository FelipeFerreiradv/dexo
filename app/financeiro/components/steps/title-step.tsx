"use client";

import { Control, Controller, FieldErrors } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput } from "@/components/ui/currency-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAYMENT_METHODS } from "@/app/lib/payment-methods";
import type { FinanceEntryFormData } from "../../lib/finance-schema";
import { UnidadeSelect } from "../shared/unidade-select";
import {
  ProductPickerBlock,
  type ProductMeta,
} from "../shared/product-picker-block";

// Sentinela: Radix Select não aceita value="" — representa "Não informado".
const PAYMENT_NONE = "__none__";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
  // ── Fase 5: venda balcão ──
  // Quando `balcaoEnabled` é true, renderiza o ProductPickerBlock no topo.
  // Sem essas props (ou `false`), o step renderiza exatamente como antes
  // — zero mudança visual/funcional para fluxos que não usam o flag.
  balcaoEnabled?: boolean;
  setValue?: (name: any, value: any, options?: any) => void;
  getValues?: () => FinanceEntryFormData;
  productMeta?: Record<string, ProductMeta>;
  setProductMeta?: (
    updater: (m: Record<string, ProductMeta>) => Record<string, ProductMeta>,
  ) => void;
}

export function TitleStep({
  control,
  errors,
  balcaoEnabled,
  setValue,
  getValues,
  productMeta,
  setProductMeta,
}: Props) {
  const showPicker =
    !!balcaoEnabled &&
    !!setValue &&
    !!getValues &&
    !!productMeta &&
    !!setProductMeta;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {showPicker && (
        <ProductPickerBlock
          control={control}
          setValue={setValue!}
          getValues={getValues!}
          productMeta={productMeta!}
          setProductMeta={setProductMeta!}
        />
      )}
      <div className="space-y-1">
        <label className="text-sm font-medium">Nº do documento</label>
        <Controller
          control={control}
          name="document"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Ex: NF 1234"
            />
          )}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Motivo</label>
        <Controller
          control={control}
          name="reason"
          render={({ field }) => (
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder="Ex: Venda de peças"
            />
          )}
        />
      </div>

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium">Forma de pagamento</label>
        <Controller
          control={control}
          name="paymentMethod"
          render={({ field }) => (
            <Select
              value={field.value ? field.value : PAYMENT_NONE}
              onValueChange={(v) =>
                field.onChange(v === PAYMENT_NONE ? null : v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Não informado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PAYMENT_NONE}>Não informado</SelectItem>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m.code} value={m.code}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <p className="text-xs text-muted-foreground">
          Opcional. Como esta conta foi/será paga (PIX, cartão, boleto, etc.).
        </p>
      </div>

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium">Unidade</label>
        <Controller
          control={control}
          name="unidadeId"
          render={({ field }) => (
            <UnidadeSelect
              value={field.value ?? null}
              onChange={(id) => field.onChange(id)}
            />
          )}
        />
        <p className="text-xs text-muted-foreground">
          Opcional. Vincule a conta a uma filial/loja para medir desempenho
          por unidade.
        </p>
      </div>

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium">Detalhes da dívida</label>
        <Controller
          control={control}
          name="debtDetails"
          render={({ field }) => (
            <Textarea
              {...field}
              value={field.value ?? ""}
              placeholder="Descrição adicional do título..."
              rows={3}
            />
          )}
        />
      </div>

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium">Valor total *</label>
        <Controller
          control={control}
          name="totalAmount"
          render={({ field }) => (
            <CurrencyInput
              value={field.value}
              onChange={(v) => field.onChange(v ?? 0)}
            />
          )}
        />
        {errors.totalAmount && (
          <p className="text-xs text-destructive">
            {errors.totalAmount.message}
          </p>
        )}
      </div>
    </div>
  );
}
