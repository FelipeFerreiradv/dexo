"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  IdCard,
  Phone,
  MapPin,
  Truck,
} from "lucide-react";
import { useSession } from "next-auth/react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StepperHeader, StepperStep } from "@/components/stepper/stepper-header";
import { StepperFooter } from "@/components/stepper/stepper-footer";
import { getApiBaseUrl } from "@/lib/api";
import { onlyDigits } from "@/app/lib/masks";

import {
  customerSchema,
  DEFAULT_CUSTOMER_VALUES,
  CustomerFormData,
} from "../lib/customer-schema";
import { IdentificationStep } from "./steps/identification-step";
import { ContactStep } from "./steps/contact-step";
import { AddressStep } from "./steps/address-step";
import { DeliveryStep } from "./steps/delivery-step";

const STEPS: (StepperStep & { fields: (keyof CustomerFormData)[] })[] = [
  {
    id: 1,
    title: "Identificação",
    description: "Dados pessoais",
    icon: IdCard,
    fields: ["name", "cpf", "rg", "birthDate", "gender", "maritalStatus"],
  },
  {
    id: 2,
    title: "Contato",
    description: "E-mail e telefones",
    icon: Phone,
    fields: ["email", "phone", "mobile"],
  },
  {
    id: 3,
    title: "Endereço",
    description: "Endereço principal",
    icon: MapPin,
    fields: [
      "cep",
      "street",
      "number",
      "complement",
      "neighborhood",
      "city",
      "state",
      "ibge",
      "reference",
    ],
  },
  {
    id: 4,
    title: "Entrega / PJ",
    description: "Dados complementares",
    icon: Truck,
    fields: [
      "deliveryName",
      "deliveryCorporateName",
      "deliveryCpf",
      "deliveryCnpj",
      "deliveryRg",
      "deliveryCep",
      "deliveryPhone",
      "deliveryCity",
      "deliveryNeighborhood",
      "deliveryState",
      "deliveryStreet",
      "deliveryComplement",
      "deliveryNumber",
      "notes",
    ],
  },
];

const TOTAL_STEPS = STEPS.length;

interface CustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: Partial<CustomerFormData> & { id?: string };
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onSaved: () => void;
}

export function CustomerDialog({
  open,
  onOpenChange,
  initialData,
  onToast,
  onSaved,
}: CustomerDialogProps) {
  const { data: session } = useSession();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEdit = !!initialData?.id;

  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema) as any,
    mode: "onChange",
    defaultValues: { ...DEFAULT_CUSTOMER_VALUES, ...initialData },
  });

  const {
    control,
    handleSubmit,
    trigger,
    setValue,
    reset,
    formState: { errors },
  } = form;

  useEffect(() => {
    if (open) {
      reset({ ...DEFAULT_CUSTOMER_VALUES, ...initialData });
      setCurrentStep(1);
    }
  }, [open, initialData, reset]);

  const validateCurrentStep = async () => {
    const fields = STEPS[currentStep - 1].fields;
    if (fields.length === 0) return true;
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
        cpf: data.cpf ? onlyDigits(data.cpf) : null,
        phone: data.phone ? onlyDigits(data.phone) : null,
        mobile: data.mobile ? onlyDigits(data.mobile) : null,
        cep: data.cep ? onlyDigits(data.cep) : null,
        deliveryCpf: data.deliveryCpf ? onlyDigits(data.deliveryCpf) : null,
        deliveryCnpj: data.deliveryCnpj ? onlyDigits(data.deliveryCnpj) : null,
        deliveryCep: data.deliveryCep ? onlyDigits(data.deliveryCep) : null,
        deliveryPhone: data.deliveryPhone
          ? onlyDigits(data.deliveryPhone)
          : null,
        birthDate: data.birthDate || null,
      };
      const url = isEdit
        ? `${getApiBaseUrl()}/customers/${initialData!.id}`
        : `${getApiBaseUrl()}/customers`;
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          email: session?.user?.email || "",
        },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Erro ao salvar cliente");
      onToast(
        isEdit
          ? "Cliente atualizado com sucesso!"
          : "Cliente criado com sucesso!",
        "success",
      );
      onSaved();
      onOpenChange(false);
    } catch (e) {
      onToast(
        e instanceof Error ? e.message : "Erro ao salvar cliente",
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
            {isEdit ? "Editar cliente" : "Novo cliente"}
          </DialogTitle>
          <DialogDescription>
            Preencha os dados do cliente em {TOTAL_STEPS} etapas.
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
              <IdentificationStep control={control} errors={errors} />
            )}
            {currentStep === 2 && (
              <ContactStep control={control} errors={errors} />
            )}
            {currentStep === 3 && (
              <AddressStep
                control={control}
                errors={errors}
                setValue={setValue}
              />
            )}
            {currentStep === 4 && (
              <DeliveryStep
                control={control}
                errors={errors}
                setValue={setValue}
              />
            )}
          </div>

          <StepperFooter
            currentStep={currentStep}
            totalSteps={TOTAL_STEPS}
            isSubmitting={isSubmitting}
            onBack={handleBack}
            onNext={handleNext}
            onSubmit={onSubmit}
            submitLabel={isEdit ? "Atualizar cliente" : "Criar cliente"}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
