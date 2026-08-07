"use client";

import { Control, Controller, FieldErrors, useWatch } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CurrencyInput, formatToBRL } from "@/components/ui/currency-input";
import type { FinanceEntryFormData } from "../../lib/finance-schema";
import { buildInstallmentPlan } from "../../lib/installment-plan";

// Bloco B — entrada + parcelamento do saldo. Flag OFF ⇒ o step renderiza
// EXATAMENTE como hoje (nº de parcelas, período, 1º vencimento e o resumo
// cosmético) e o payload não carrega `installmentPlan`.
const SALE_INSTALLMENTS_ENABLED =
  process.env.NEXT_PUBLIC_SALE_INSTALLMENTS_ENABLED === "true";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
  // Só na venda balcão existe o conceito de "entrada no ato" (é o caixa).
  balcaoEnabled?: boolean;
}

function formatDueDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // UTC: as datas do plano são geradas em UTC (ver installment-plan.ts).
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

export function InstallmentsStep({ control, errors, balcaoEnabled }: Props) {
  const values = useWatch({ control });
  const installments = values.installments || 1;
  const total = values.totalAmount || 0;
  const perInstallment = total / installments;
  const periodDays = values.periodDays ?? 30;

  const splitUi = SALE_INSTALLMENTS_ENABLED && !!balcaoEnabled;
  const splitOn = splitUi && values.splitPayment === true;

  // Ver o aviso abaixo: o alvo do "Pagamento combinado" (passo Título) muda
  // para a ENTRADA quando o parcelamento é ligado aqui.
  const cents = (v: number) => Math.round(Number(v || 0) * 100);
  const linhasPagamento = (values.payments ?? []) as Array<{ amount?: number }>;
  const somaPagamentos =
    linhasPagamento.reduce((acc, p) => acc + cents(p?.amount ?? 0), 0) / 100;
  const entradaAtual = values.downPayment ?? 0;
  const pagamentoDesencontrado =
    splitOn &&
    linhasPagamento.length > 0 &&
    cents(somaPagamentos) !== cents(entradaAtual);
  const plano = splitOn
    ? buildInstallmentPlan({
        totalAmount: total,
        downPayment: values.downPayment ?? 0,
        count: installments,
        periodDays,
        firstDueDate: values.dueDate ?? "",
      })
    : null;

  return (
    <div className="space-y-6">
      {splitUi && (
        <div className="space-y-3 rounded-lg border border-border/70 bg-muted/10 p-3">
          <div className="flex items-start gap-3">
            <Controller
              control={control}
              name="splitPayment"
              render={({ field }) => (
                <Switch
                  id="split-payment"
                  checked={field.value === true}
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <div className="flex flex-col">
              <label htmlFor="split-payment" className="text-sm font-medium">
                Receber entrada e parcelar o saldo
              </label>
              <span className="text-xs text-muted-foreground">
                A entrada é recebida agora (e baixa o estoque). O saldo vira uma
                conta a receber por parcela, com baixa individual.
              </span>
            </div>
          </div>

          {splitOn && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Entrada *</label>
              <Controller
                control={control}
                name="downPayment"
                render={({ field }) => (
                  <CurrencyInput
                    value={field.value ?? 0}
                    onChange={(v) => field.onChange(v ?? 0)}
                    placeholder="Valor recebido no ato"
                  />
                )}
              />
              {errors.downPayment?.message && (
                <p className="text-xs text-destructive">
                  {String(errors.downPayment.message)}
                </p>
              )}
              {/* O bloco "Pagamento combinado" vive no passo TÍTULO, mas ao
                  ligar o parcelamento aqui o alvo dele muda para a ENTRADA —
                  e um erro invisível dois passos atrás travaria o submit sem
                  explicação. Por isso o aviso é repetido aqui. */}
              {pagamentoDesencontrado && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  As formas de pagamento somam{" "}
                  <strong>R$ {formatToBRL(somaPagamentos)}</strong>, mas a
                  entrada é <strong>R$ {formatToBRL(entradaAtual)}</strong>. Com
                  parcelamento, o pagamento combinado descreve só o que entra
                  agora — ajuste no passo <strong>Título</strong>.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">Nº de parcelas *</label>
          <Controller
            control={control}
            name="installments"
            render={({ field }) => (
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={360}
                value={field.value ?? 1}
                onChange={(e) =>
                  field.onChange(Number(e.target.value) || 1)
                }
              />
            )}
          />
          {errors.installments && (
            <p className="text-xs text-destructive">
              {errors.installments.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Período (dias)</label>
          <Controller
            control={control}
            name="periodDays"
            render={({ field }) => (
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={field.value ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  field.onChange(v === "" ? null : Number(v));
                }}
                placeholder="30"
              />
            )}
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">1º vencimento *</label>
          <Controller
            control={control}
            name="dueDate"
            render={({ field }) => (
              <Input
                type="date"
                value={field.value ?? ""}
                onChange={field.onChange}
              />
            )}
          />
          {errors.dueDate && (
            <p className="text-xs text-destructive">
              {errors.dueDate.message}
            </p>
          )}
        </div>
      </div>

      {/* Prévia REAL do split: as mesmas linhas que vão ao backend (mesma
          função pura), com o resíduo de centavos já na última parcela. */}
      {splitOn ? (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4">
          <p className="text-xs uppercase text-muted-foreground">
            Prévia do parcelamento
          </p>
          {!plano ? (
            <p className="font-mono text-[11px] text-destructive">
              Informe total, entrada (menor que o total), nº de parcelas e o 1º
              vencimento.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-y-1 text-sm">
                <span className="text-muted-foreground">Total da venda:</span>
                <span className="text-right font-medium">
                  R$ {formatToBRL(total)}
                </span>
                <span className="text-muted-foreground">Entrada (agora):</span>
                <span className="text-right font-medium">
                  R$ {formatToBRL(plano.downPayment)}
                </span>
                <span className="text-muted-foreground">Saldo parcelado:</span>
                <span className="text-right font-medium">
                  R$ {formatToBRL(plano.balance)}
                </span>
              </div>
              <ul className="grid grid-cols-1 gap-x-6 border-t border-border/60 pt-2 font-mono text-[11px] sm:grid-cols-2">
                {plano.installments.map((p, i) => (
                  <li
                    key={i}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <span className="text-muted-foreground">
                      {i + 1}/{plano.installments.length}{" "}
                      {formatDueDate(p.dueDate)}
                    </span>
                    <span className="tabular-nums">
                      R$ {formatToBRL(p.amount)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                Serão criadas {plano.installments.length} contas a receber, uma
                por parcela, cada uma com baixa própria.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
          <p className="text-xs uppercase text-muted-foreground">Resumo</p>
          <div className="grid grid-cols-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">Valor total:</span>
            <span className="text-right font-medium">
              R$ {formatToBRL(total)}
            </span>
            <span className="text-muted-foreground">Parcelas:</span>
            <span className="text-right font-medium">
              {installments}x de R$ {formatToBRL(perInstallment)}
            </span>
            <span className="text-muted-foreground">Intervalo:</span>
            <span className="text-right font-medium">{periodDays} dia(s)</span>
          </div>
        </div>
      )}
    </div>
  );
}
