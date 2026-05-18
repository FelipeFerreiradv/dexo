"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CalendarClock,
  FileText,
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
    fields: ["document", "reason", "debtDetails", "totalAmount", "unidadeId"],
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
    formState: { errors },
  } = form;

  useEffect(() => {
    if (open) {
      reset({ ...DEFAULT_FINANCE_VALUES, ...initialData });
      setSelectedCustomer(initialData?.customer ?? null);
      setCurrentStep(1);
      setEmitReceipt(false);
    }
  }, [open, initialData, reset]);

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
              <TitleStep control={control} errors={errors} />
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
