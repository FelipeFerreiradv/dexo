"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, MapPin, Settings2, Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";

import {
  StepperHeader,
  StepperStep,
} from "@/components/stepper/stepper-header";
import { StepperFooter } from "@/components/stepper/stepper-footer";
import { getApiBaseUrl } from "@/lib/api";
import { onlyDigits } from "@/app/lib/masks";

import {
  fiscalConfigSchema,
  DEFAULT_FISCAL_CONFIG,
  FiscalConfigFormData,
} from "../lib/fiscal-config-schema";
import { FiscalIdentificationStep } from "./steps/identification-step";
import { FiscalAddressStep } from "./steps/address-step";
import { FiscalEnvironmentStep } from "./steps/environment-step";

const STEPS: (StepperStep & { fields: (keyof FiscalConfigFormData)[] })[] = [
  {
    id: 1,
    title: "Identificação",
    description: "Dados do emissor",
    icon: Building2,
    fields: [
      "cnpj",
      "razaoSocial",
      "nomeFantasia",
      "inscricaoEstadual",
      "inscricaoMunicipal",
      "regimeTributario",
      "cnae",
    ],
  },
  {
    id: 2,
    title: "Endereço fiscal",
    description: "Endereço do emissor",
    icon: MapPin,
    fields: [
      "cep",
      "logradouro",
      "numero",
      "complemento",
      "bairro",
      "municipio",
      "codMunicipio",
      "uf",
    ],
  },
  {
    id: 3,
    title: "Ambiente & Provedor",
    description: "Homologação e Focus NFe",
    icon: Settings2,
    fields: ["ambiente", "providerName", "providerToken"],
  },
];

const TOTAL_STEPS = STEPS.length;

interface Props {
  productionUnlocked: boolean;
}

type ToastType = "success" | "error" | "warning";

export function FiscalConfigForm({ productionUnlocked }: Props) {
  const { data: session } = useSession();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(
    null,
  );

  const form = useForm<FiscalConfigFormData>({
    resolver: zodResolver(fiscalConfigSchema) as any,
    mode: "onChange",
    defaultValues: DEFAULT_FISCAL_CONFIG,
  });

  const {
    control,
    handleSubmit,
    trigger,
    reset,
    setValue,
    formState: { errors },
  } = form;

  const showToast = (msg: string, type: ToastType) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    const load = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(`${getApiBaseUrl()}/fiscal/config`, {
          headers: { email: session.user.email },
        });
        if (!res.ok) throw new Error("Erro ao carregar configuração");
        const data = await res.json();
        if (data?.config) {
          reset({
            ...DEFAULT_FISCAL_CONFIG,
            ...data.config,
            cnpj: data.config.cnpj ?? "",
            nomeFantasia: data.config.nomeFantasia ?? "",
            inscricaoMunicipal: data.config.inscricaoMunicipal ?? "",
            cnae: data.config.cnae ?? "",
            cep: data.config.cep ?? "",
            logradouro: data.config.logradouro ?? "",
            numero: data.config.numero ?? "",
            complemento: data.config.complemento ?? "",
            bairro: data.config.bairro ?? "",
            municipio: data.config.municipio ?? "",
            codMunicipio: data.config.codMunicipio ?? "",
            uf: data.config.uf ?? "",
            providerName: data.config.providerName ?? "FOCUS_NFE",
            providerToken: data.config.providerToken ?? "",
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [session?.user?.email, reset]);

  const validateStep = async () => {
    const fields = STEPS[currentStep - 1].fields;
    const ok = await trigger(fields);
    if (!ok) {
      const first = fields.map((f) => errors[f]?.message).filter(Boolean)[0];
      if (first) showToast(first as string, "warning");
    }
    return ok;
  };

  const handleNext = async () => {
    const ok = await validateStep();
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
        cnpj: onlyDigits(data.cnpj),
        cep: data.cep ? onlyDigits(data.cep) : null,
      };
      const res = await fetch(`${getApiBaseUrl()}/fiscal/config`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          email: session?.user?.email || "",
        },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Erro ao salvar configuração");
      }
      showToast("Configuração fiscal salva com sucesso!", "success");
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Erro ao salvar configuração",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Carregando configuração...
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-2xl border border-border/60 bg-card/80 p-6 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
      <StepperHeader
        steps={STEPS}
        currentStep={currentStep}
        onGoToStep={goToStep}
      />

      <div>
        {currentStep === 1 && (
          <FiscalIdentificationStep control={control} errors={errors} />
        )}
        {currentStep === 2 && (
          <FiscalAddressStep
            control={control}
            errors={errors}
            setValue={setValue}
          />
        )}
        {currentStep === 3 && (
          <FiscalEnvironmentStep
            control={control}
            errors={errors}
            productionUnlocked={productionUnlocked}
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
        submitLabel="Salvar configuração"
      />

      {toast && (
        <div
          className={
            "fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm shadow-lg " +
            (toast.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : toast.type === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700")
          }
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
