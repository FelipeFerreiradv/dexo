"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CalendarClock,
  FileText,
  Loader2,
  Percent,
  Receipt,
  User as UserIcon,
} from "lucide-react";
import { useSession } from "next-auth/react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  StepperHeader,
  StepperStep,
} from "@/components/stepper/stepper-header";
import { StepperFooter } from "@/components/stepper/stepper-footer";
import { getApiBaseUrl } from "@/lib/api";

import {
  financeEntrySchema,
  DEFAULT_FINANCE_VALUES,
  FinanceEntryFormData,
} from "../lib/finance-schema";
import { downloadReceipt } from "../lib/download-receipt";
import { CustomerStep } from "./steps/customer-step";
import { TitleStep } from "./steps/title-step";
import { FeesStep } from "./steps/fees-step";
import { InstallmentsStep } from "./steps/installments-step";
import type { CustomerOption } from "./shared/customer-combobox";
import type { ProductMeta } from "./shared/product-picker-block";

export type FinanceKind = "receivable" | "payable";

const STEPS: (StepperStep & { fields: (keyof FinanceEntryFormData)[] })[] = [
  {
    id: 1,
    title: "Cliente",
    description: "Quem está envolvido",
    icon: UserIcon,
    fields: ["customerId", "newCustomerName"],
  },
  {
    id: 2,
    title: "Título",
    description: "Documento e valor",
    icon: FileText,
    // `items` é opcional no zod — quando o flag de balcão está OFF, ele é
    // ausente/[]; quando ON, vira a lista do ProductPickerBlock. Incluir aqui
    // não tem custo nos dois casos (zod aceita undefined/[]/valid array).
    fields: [
      "document",
      "reason",
      "debtDetails",
      "totalAmount",
      "unidadeId",
      "items",
    ],
  },
  {
    id: 3,
    title: "Encargos",
    description: "Multa e juros",
    icon: Percent,
    fields: ["fineAmount", "finePercent", "interestPercent", "toleranceDays"],
  },
  {
    id: 4,
    title: "Parcelamento",
    description: "Vencimento e parcelas",
    icon: CalendarClock,
    fields: ["installments", "periodDays", "dueDate"],
  },
];

const TOTAL_STEPS = STEPS.length;

// Flag de feature para venda balcão (Fase 5). Lido em módulo (Next.js
// compila NEXT_PUBLIC_* no bundle do client). Quando ausente/false, a UI
// renderiza EXATAMENTE como antes — sem bloco de produtos, sem items no
// payload. Removido na Fase 10 após smoke test em produção controlada.
const BALCAO_SALE_ENABLED =
  process.env.NEXT_PUBLIC_BALCAO_SALE_ENABLED === "true";

interface FinanceDialogProps {
  kind: FinanceKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: Partial<FinanceEntryFormData> & {
    id?: string;
    customer?: CustomerOption | null;
  };
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onSaved: () => void;
}

export function FinanceDialog({
  kind,
  open,
  onOpenChange,
  initialData,
  onToast,
  onSaved,
}: FinanceDialogProps) {
  const { data: session } = useSession();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerOption | null>(initialData?.customer ?? null);
  const [emitReceipt, setEmitReceipt] = useState(false);

  const isEdit = !!initialData?.id;
  const label = kind === "receivable" ? "a receber" : "a pagar";
  const canEmitReceipt = kind === "receivable";
  // Fase 8: estado de "emitindo rascunho fiscal" — independente do submit
  // do form (fluxo paralelo, conta já existe).
  const [isEmittingFiscal, setIsEmittingFiscal] = useState(false);

  const form = useForm<FinanceEntryFormData>({
    resolver: zodResolver(financeEntrySchema) as any,
    mode: "onChange",
    defaultValues: { ...DEFAULT_FINANCE_VALUES, ...initialData },
  });

  const {
    control,
    handleSubmit,
    trigger,
    reset,
    setValue,
    getValues,
    formState: { errors },
  } = form;

  // Balcão só é habilitado em receivable (payable nunca tem items — backend
  // também rejeita). Verifica o flag e o kind para gatear toda a UX de venda
  // balcão (bloco de produtos + serialização de items no payload).
  const balcaoEnabled = BALCAO_SALE_ENABLED && kind === "receivable";

  // ProductMeta (SKU/nome/estoque por productId) vive no dialog para sobreviver
  // à navegação entre steps (TitleStep desmonta ao mudar de step). É (re)seedado
  // a cada abertura a partir de initialData.items (snapshot do backend), e
  // populado também ao selecionar via lookup no ProductPickerBlock.
  const [productMeta, setProductMeta] = useState<
    Record<string, ProductMeta>
  >({});

  // Fase 8: items em tempo real para gatear o botão de cupom fiscal (só faz
  // sentido oferecer quando a conta tem itens vinculados). useWatch garante
  // re-render quando o usuário adiciona/remove no ProductPickerBlock.
  const watchedItems = useWatch({ control, name: "items" });
  const hasItemsInForm =
    Array.isArray(watchedItems) && watchedItems.length > 0;

  useEffect(() => {
    if (open) {
      reset({ ...DEFAULT_FINANCE_VALUES, ...initialData });
      setSelectedCustomer(initialData?.customer ?? null);
      setCurrentStep(1);
      setEmitReceipt(false);
      // Seed do productMeta a partir do snapshot do backend (Fase 5 / balcão).
      // O backend (findById) traz items.product = { id, sku, name }; usamos
      // para o bloco já mostrar SKU/nome em fluxo de edição. Estoque não vem
      // no snapshot — vira 0 até o usuário re-pesquisar e re-selecionar.
      const items = (initialData as any)?.items;
      if (balcaoEnabled && Array.isArray(items) && items.length > 0) {
        const seed: Record<string, ProductMeta> = {};
        for (const it of items) {
          if (it?.product && it.productId) {
            seed[it.productId] = {
              sku: it.product.sku,
              name: it.product.name,
              stock: 0,
            };
          }
        }
        setProductMeta(seed);
      } else {
        setProductMeta({});
      }
    }
  }, [open, initialData, reset, balcaoEnabled]);

  const validateCurrentStep = async () => {
    const fields = STEPS[currentStep - 1].fields;
    const ok = await trigger(fields);
    if (!ok) {
      const first = fields
        .map((f) => errors[f]?.message)
        .filter(Boolean)[0];
      if (first) onToast(first as string, "warning");
    }
    return ok;
  };

  const handleNext = async () => {
    const ok = await validateCurrentStep();
    if (ok && currentStep < TOTAL_STEPS) setCurrentStep((p) => p + 1);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep((p) => p - 1);
  };

  const goToStep = (step: number) => {
    if (step < currentStep) setCurrentStep(step);
  };

  const onSubmit = handleSubmit(async (data) => {
    setIsSubmitting(true);
    try {
      // Campos auxiliares do cadastro rápido não vão ao backend como tais —
      // viram o objeto `newCustomer` (ou nada, no fluxo antigo).
      const { quickCreateCustomer, newCustomerName, newCustomerCpf, ...rest } =
        data;
      const payload: Record<string, unknown> = {
        ...rest,
        document: rest.document || null,
        reason: rest.reason || null,
        debtDetails: rest.debtDetails || null,
        unidadeId: rest.unidadeId || null,
        dueDate: new Date(rest.dueDate).toISOString(),
      };
      if (quickCreateCustomer) {
        // Quick: cria cliente novo na mesma transação; sem customerId.
        payload.newCustomer = {
          name: (newCustomerName || "").trim(),
          cpf: newCustomerCpf ? newCustomerCpf : null,
        };
        delete payload.customerId;
      }
      // Defesa-em-profundidade: quando o flag de balcão está OFF (ou em
      // payable), garantimos que nenhum `items` vaze pro backend. O backend
      // já é tolerante (validateItems é no-op se ausente), mas o payload
      // fica idêntico ao da Fase 1.
      if (!balcaoEnabled) {
        delete payload.items;
      } else if (
        Array.isArray((payload as any).items) &&
        (payload as any).items.length === 0
      ) {
        // items: [] equivale a "sem items" — não enviar reduz ruído.
        delete payload.items;
      }
      const basePath =
        kind === "receivable" ? "/finance/receivables" : "/finance/payables";
      const url = isEdit
        ? `${getApiBaseUrl()}${basePath}/${initialData!.id}`
        : `${getApiBaseUrl()}${basePath}`;
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          email: session?.user?.email || "",
        },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok)
        throw new Error(result.error || `Erro ao salvar conta ${label}`);
      onToast(
        isEdit
          ? `Conta ${label} atualizada com sucesso!`
          : `Conta ${label} criada com sucesso!`,
        "success",
      );

      if (canEmitReceipt && emitReceipt) {
        const savedId = result?.entry?.id as string | undefined;
        const userEmail = session?.user?.email;
        if (savedId && userEmail) {
          // Fire-and-forget: fecha o dialog imediatamente enquanto o cupom
          // é gerado e baixado em paralelo. Erros viram toast warning, sem
          // bloquear a UX do save (que já foi confirmado com sucesso).
          void downloadReceipt(savedId, userEmail).catch((err) => {
            onToast(
              err instanceof Error
                ? err.message
                : "Não foi possível emitir o cupom",
              "warning",
            );
          });
        }
      }

      onSaved();
      onOpenChange(false);
    } catch (e) {
      onToast(
        e instanceof Error ? e.message : `Erro ao salvar conta ${label}`,
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  });

  // Fase 8: dispara POST /finance/receivables/<id>/fiscal-draft. Fluxo
  // paralelo ao submit — conta JÁ existe (isEdit). Após sucesso, o usuário
  // navega ao módulo Notas Fiscais para revisar NCM e emitir. Mantemos o
  // dialog aberto (não fecha) para o usuário poder ajustar outros campos.
  const handleEmitFiscalDraft = async () => {
    if (!initialData?.id) return;
    const userEmail = session?.user?.email;
    if (!userEmail) {
      onToast("Sessão inválida — faça login novamente", "error");
      return;
    }
    setIsEmittingFiscal(true);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/finance/receivables/${initialData.id}/fiscal-draft`,
        {
          method: "POST",
          headers: { email: userEmail, "content-type": "application/json" },
        },
      );
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Erro ao criar rascunho fiscal");
      }
      onToast(
        "Rascunho de NF-e criado. Revise NCM no módulo Notas Fiscais e emita.",
        "success",
      );
    } catch (e) {
      onToast(
        e instanceof Error ? e.message : "Erro ao criar rascunho fiscal",
        "error",
      );
    } finally {
      setIsEmittingFiscal(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-187.5">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? `Editar conta ${label}`
              : `Nova conta ${label}`}
          </DialogTitle>
          <DialogDescription>
            Preencha os dados do título em {TOTAL_STEPS} etapas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 pt-2">
          <StepperHeader
            steps={STEPS}
            currentStep={currentStep}
            onGoToStep={goToStep}
          />

          <div>
            {currentStep === 1 && (
              <CustomerStep
                control={control}
                errors={errors}
                selected={selectedCustomer}
                onSelect={setSelectedCustomer}
                setValue={setValue}
                allowQuickCreate={!isEdit}
              />
            )}
            {currentStep === 2 && (
              <TitleStep
                control={control}
                errors={errors}
                balcaoEnabled={balcaoEnabled}
                setValue={balcaoEnabled ? setValue : undefined}
                getValues={balcaoEnabled ? getValues : undefined}
                productMeta={balcaoEnabled ? productMeta : undefined}
                setProductMeta={
                  balcaoEnabled ? setProductMeta : undefined
                }
              />
            )}
            {currentStep === 3 && (
              <FeesStep control={control} errors={errors} />
            )}
            {currentStep === 4 && (
              <div className="space-y-4">
                <InstallmentsStep control={control} errors={errors} />

                {canEmitReceipt && (
                  <div className="flex items-start justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background">
                        <Receipt className="size-4 text-muted-foreground" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          Emitir cupom sem validade fiscal
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Ao salvar, um cupom de venda balcão será
                          baixado automaticamente. Este documento não
                          possui validade fiscal.
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={emitReceipt}
                      onCheckedChange={setEmitReceipt}
                      aria-label="Emitir cupom sem validade fiscal"
                    />
                  </div>
                )}

                {/* Fase 8 — Cupom fiscal de verdade (NF-e modelo 55).
                    Distinto do Switch acima (sem-validade preservado intacto).
                    Aparece somente em edição com itens + flag de balcão ON. */}
                {balcaoEnabled && isEdit && hasItemsInForm && (
                  <div className="flex items-start justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background">
                        <FileText className="size-4 text-muted-foreground" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          Emitir cupom fiscal (NF-e modelo 55)
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Gera um rascunho fiscal com os itens desta conta
                          (CFOP 5102, presencial). Você revisa o NCM no
                          módulo Notas Fiscais e emite.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleEmitFiscalDraft}
                      disabled={isEmittingFiscal}
                    >
                      {isEmittingFiscal && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      Criar rascunho
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <StepperFooter
            currentStep={currentStep}
            totalSteps={TOTAL_STEPS}
            isSubmitting={isSubmitting}
            onBack={handleBack}
            onNext={handleNext}
            onSubmit={onSubmit}
            submitLabel={isEdit ? "Atualizar" : `Criar conta ${label}`}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
