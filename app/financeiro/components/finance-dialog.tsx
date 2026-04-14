"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CalendarClock,
  FileText,
  Percent,
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
    fields: ["customerId"],
  },
  {
    id: 2,
    title: "Título",
    description: "Documento e valor",
    icon: FileText,
    fields: ["document", "reason", "debtDetails", "totalAmount"],
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

  const isEdit = !!initialData?.id;
  const label = kind === "receivable" ? "a receber" : "a pagar";

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
    formState: { errors },
  } = form;

  useEffect(() => {
    if (open) {
      reset({ ...DEFAULT_FINANCE_VALUES, ...initialData });
      setSelectedCustomer(initialData?.customer ?? null);
      setCurrentStep(1);
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
      const payload = {
        ...data,
        document: data.document || null,
        reason: data.reason || null,
        debtDetails: data.debtDetails || null,
        dueDate: new Date(data.dueDate).toISOString(),
      };
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
              />
            )}
            {currentStep === 2 && (
              <TitleStep control={control} errors={errors} />
            )}
            {currentStep === 3 && (
              <FeesStep control={control} errors={errors} />
            )}
            {currentStep === 4 && (
              <InstallmentsStep control={control} errors={errors} />
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
