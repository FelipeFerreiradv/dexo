"use client";

import {
  Control,
  Controller,
  useFieldArray,
  useWatch,
} from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CurrencyInput, formatToBRL } from "@/components/ui/currency-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { paymentMethodsForKind } from "@/app/lib/payment-methods";
import type { FinanceEntryFormData } from "../../lib/finance-schema";

// Bloco A — mais de uma forma de pagamento na mesma venda.
//
// Aparece só com NEXT_PUBLIC_MULTI_PAYMENT_ENABLED ligada (o gate está no
// TitleStep). Sem linhas, o `Select` único de "Forma de pagamento" continua
// mandando e o payload não carrega `payments` — venda simples fica idêntica.
//
// Troco: calculado e exibido, NUNCA persistido. A linha gravada é o valor
// APLICADO à venda; o que o cliente entregou é diferença de caixa.

const cents = (v: number) => Math.round(Number(v || 0) * 100);

interface Props {
  control: Control<FinanceEntryFormData>;
  kind?: "receivable" | "payable";
}

export function PaymentsBlock({ control, kind }: Props) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "payments",
  });
  const watched = useWatch({ control, name: "payments" }) as
    | Array<{ method?: string; amount?: number; tendered?: number | null }>
    | undefined;
  const totalAmount =
    (useWatch({ control, name: "totalAmount" }) as number | undefined) ?? 0;
  // Bloco A × Bloco B: com entrada + parcelas, as linhas de pagamento
  // descrevem O QUE ENTROU AGORA — ou seja, a ENTRADA, não o total da venda.
  // O saldo vira contas a receber e ainda não foi pago por forma nenhuma.
  // Sem este alvo variável, o bloco fecharia contra o total e o backend
  // rejeitaria a venda (as duas validações discordariam).
  const splitOn =
    (useWatch({ control, name: "splitPayment" }) as boolean | undefined) === true;
  const downPayment =
    (useWatch({ control, name: "downPayment" }) as number | undefined) ?? 0;

  const alvo = splitOn ? downPayment : totalAmount;
  const alvoLabel = splitOn ? "Entrada (a receber agora)" : "Total da venda";

  const lines = watched ?? [];
  const somaCents = lines.reduce((acc, p) => acc + cents(p?.amount ?? 0), 0);
  const totalCents = cents(alvo);
  const diffCents = totalCents - somaCents;

  const methods = paymentMethodsForKind(kind ?? "receivable");

  const handleAdd = () => {
    // A primeira linha já nasce com o que falta para fechar — no balcão, o
    // caso comum é "o resto em dinheiro", e digitar o valor de novo é atrito.
    const restante = Math.max(0, diffCents) / 100;
    append({ method: "", amount: restante, tendered: null } as any);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-muted/10 p-3 md:col-span-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Pagamento combinado</p>
          <p className="text-xs text-muted-foreground">
            Parte em PIX, parte em dinheiro, parte no cartão. A soma tem de
            fechar com{" "}
            {splitOn ? (
              <strong>a entrada</strong>
            ) : (
              "o total da venda"
            )}
            .
            {splitOn
              ? " O saldo parcelado ainda não foi pago — ele vira contas a receber."
              : ""}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={handleAdd}>
          <Plus className="h-4 w-4" />
          Adicionar forma
        </Button>
      </div>

      {fields.length === 0 ? (
        <p className="py-2 text-center font-mono text-[11px] text-muted-foreground">
          Nenhuma forma adicionada — a venda usa a “Forma de pagamento” acima.
        </p>
      ) : (
        <div className="space-y-2">
          {fields.map((f, index) => {
            const linha = lines[index];
            const isDinheiro = linha?.method === "DINHEIRO";
            const trocoCents = isDinheiro
              ? cents(linha?.tendered ?? 0) - cents(linha?.amount ?? 0)
              : 0;
            return (
              <div key={f.id} className="space-y-1">
                <div className="flex items-start gap-2">
                  <div className="w-[42%] min-w-0">
                    <Controller
                      control={control}
                      name={`payments.${index}.method` as const}
                      render={({ field }) => (
                        <Select
                          value={field.value || undefined}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Forma" />
                          </SelectTrigger>
                          <SelectContent>
                            {methods.map((m) => (
                              <SelectItem key={m.code} value={m.code}>
                                {m.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Controller
                      control={control}
                      name={`payments.${index}.amount` as const}
                      render={({ field }) => (
                        <CurrencyInput
                          value={field.value ?? 0}
                          // CurrencyInput devolve null ao limpar o campo; o
                          // schema espera número. 0 dispara a mensagem certa
                          // ("valor deve ser maior que zero") em vez de um erro
                          // de tipo do zod.
                          onChange={(v) => field.onChange(v ?? 0)}
                          placeholder="Valor"
                        />
                      )}
                    />
                  </div>
                  {isDinheiro && (
                    <div className="min-w-0 flex-1">
                      <Controller
                        control={control}
                        name={`payments.${index}.tendered` as const}
                        render={({ field }) => (
                          <CurrencyInput
                            value={field.value ?? 0}
                            onChange={(v) => field.onChange(v)}
                            placeholder="Recebido"
                          />
                        )}
                      />
                    </div>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Remover forma de pagamento"
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
                {isDinheiro && trocoCents > 0 && (
                  <p className="pl-[42%] font-mono text-[11px] text-muted-foreground">
                    Troco: {formatToBRL(trocoCents / 100)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {fields.length > 0 && (
        <div className="space-y-1 border-t border-border/60 pt-2 font-mono text-xs">
          <div className="flex justify-between text-muted-foreground">
            <span>{alvoLabel}</span>
            <span className="tabular-nums">{formatToBRL(alvo)}</span>
          </div>
          {splitOn && (
            <div className="flex justify-between text-muted-foreground">
              <span>Total da venda</span>
              <span className="tabular-nums">{formatToBRL(totalAmount)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Somado</span>
            <span className="tabular-nums">{formatToBRL(somaCents / 100)}</span>
          </div>
          <div
            className={cn(
              "flex justify-between font-medium",
              diffCents === 0 ? "text-green-600" : "text-destructive",
            )}
          >
            <span>
              {diffCents === 0
                ? "Confere"
                : diffCents > 0
                  ? "Faltam"
                  : "Excedem"}
            </span>
            <span className="tabular-nums">
              {diffCents === 0
                ? "✓"
                : formatToBRL(Math.abs(diffCents) / 100)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
