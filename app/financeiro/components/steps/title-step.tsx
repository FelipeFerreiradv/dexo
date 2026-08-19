"use client";

import { Control, Controller, FieldErrors, useWatch } from "react-hook-form";
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
import { paymentMethodsForKind } from "@/app/lib/payment-methods";
import type { FinanceEntryFormData } from "../../lib/finance-schema";
import { UnidadeSelect } from "../shared/unidade-select";
import { BankAccountSelect } from "../shared/bank-account-select";
import {
  ProductPickerBlock,
  type ProductMeta,
} from "../shared/product-picker-block";
import { PaymentsBlock } from "../shared/payments-block";

// Sentinela: Radix Select não aceita value="" — representa "Não informado".
const PAYMENT_NONE = "__none__";

// Bloco A — pagamento combinado. Flag OFF ⇒ o step renderiza exatamente como
// hoje (só o Select único) e o payload não carrega `payments`.
const MULTI_PAYMENT_ENABLED =
  process.env.NEXT_PUBLIC_MULTI_PAYMENT_ENABLED === "true";

interface Props {
  control: Control<FinanceEntryFormData>;
  errors: FieldErrors<FinanceEntryFormData>;
  // Aba atual: "Fiado" só é ofertado em "a receber". Ausente => trata como
  // "payable" (default seguro: nunca vaza "Fiado" onde não deve).
  kind?: "receivable" | "payable";
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
  scrapMeta?: Record<string, string>;
  setScrapMeta?: (
    updater: (m: Record<string, string>) => Record<string, string>,
  ) => void;
  /**
   * BLOCO A — mostra o seletor de conta bancária / caixa. AUSENTE ⇒ o passo
   * renderiza exatamente como hoje, sem campo e sem request novo.
   */
  showBankAccount?: boolean;
  /** Sugerir a conta PADRÃO (só na CRIAÇÃO — ver BankAccountSelect). */
  autoSelectDefaultAccount?: boolean;
}

export function TitleStep({
  control,
  errors,
  kind,
  balcaoEnabled,
  setValue,
  getValues,
  productMeta,
  setProductMeta,
  scrapMeta,
  setScrapMeta,
  showBankAccount,
  autoSelectDefaultAccount,
}: Props) {
  const showPicker =
    !!balcaoEnabled &&
    !!setValue &&
    !!getValues &&
    !!productMeta &&
    !!setProductMeta &&
    !!scrapMeta &&
    !!setScrapMeta;

  // O bloco de pagamento combinado só existe com a flag ligada E na venda
  // balcão. Fora daí nada abaixo é lido — e a inscrição do useWatch fica
  // DESLIGADA, para o passo Título não voltar a renderizar a cada tecla nos
  // fluxos que não usam o bloco (que são todos os de hoje).
  const paymentsUi = MULTI_PAYMENT_ENABLED && showPicker;

  // O erro de fechamento vem do superRefine do zod, que o RHF só reavalia no
  // submit. Sem isto, o operador corrige os valores, o bloco já mostra
  // "Confere ✓" e a mensagem vermelha antiga continua na tela — dizendo que
  // falta dinheiro numa venda que já fecha. Escondemos o erro assim que a
  // soma bate ao vivo; a validação de verdade continua no submit e no backend.
  //
  // Assinatura ESTREITA (4 campos), não o formulário inteiro: observar tudo
  // fazia este passo — e com ele o ProductPickerBlock e suas linhas de item —
  // re-renderizar a cada tecla digitada em Nº do documento, Motivo, Detalhes
  // da dívida e Unidade. São exatamente os 4 campos que o cálculo lê.
  const [wPayments, wSplit, wDown, wTotal] = useWatch({
    control,
    name: ["payments", "splitPayment", "downPayment", "totalAmount"],
    disabled: !paymentsUi,
  });
  const paymentsError = (() => {
    if (!paymentsUi) return null;
    const msg = errors.payments?.message;
    if (!msg) return null;
    const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
    const linhas = (wPayments ?? []) as Array<{ amount?: number }>;
    if (linhas.length === 0) return String(msg);
    const soma = linhas.reduce((acc, p) => acc + cents(p?.amount), 0);
    const alvo = wSplit ? cents(wDown) : cents(wTotal);
    return soma === alvo ? null : String(msg);
  })();

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {showPicker && (
        <ProductPickerBlock
          control={control}
          setValue={setValue!}
          getValues={getValues!}
          productMeta={productMeta!}
          setProductMeta={setProductMeta!}
          scrapMeta={scrapMeta!}
          setScrapMeta={setScrapMeta!}
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
                {paymentMethodsForKind(kind ?? "payable").map((m) => (
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
          {paymentsUi ? " Para pagamento combinado, use o bloco abaixo." : ""}
        </p>
      </div>

      {/* BLOCO A — vizinho da forma de pagamento porque é a outra metade da
          mesma pergunta: "como" e "para onde". Flag OFF (ou nenhuma conta
          cadastrada) ⇒ o seletor não é montado. */}
      {showBankAccount && (
        <div className="md:col-span-2">
          <Controller
            control={control}
            name="bankAccountId"
            render={({ field }) => (
              <BankAccountSelect
                value={field.value ?? null}
                onChange={field.onChange}
                label={
                  kind === "payable"
                    ? "Conta de onde sai o dinheiro"
                    : "Conta onde o dinheiro entra"
                }
                autoSelectDefault={autoSelectDefaultAccount}
              />
            )}
          />
        </div>
      )}

      {/* Bloco A — só na venda balcão (onde existe o conceito de fechamento de
          caixa) e só com a flag ligada. MESMA condição do `disabled` do
          useWatch acima: se as duas divergirem, ou o aviso congela ou o
          formulário volta a re-renderizar à toa. */}
      {paymentsUi && (
        <>
          <PaymentsBlock control={control} kind={kind} />
          {paymentsError && (
            <p className="-mt-2 text-sm text-destructive md:col-span-2">
              {paymentsError}
            </p>
          )}
        </>
      )}

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
