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
import { ToastViewport } from "@/components/ui/toast-viewport";
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
import { type CertificateStatus } from "./steps/certificate-upload";

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
    description: "Ambiente, provedor e certificado",
    icon: Settings2,
    fields: [
      "ambiente",
      "providerName",
      "providerToken",
      // NFC-e (Fase 2) — validados no mesmo step.
      "serieNfce",
      "cscId",
      "cscToken",
      "ncmPadrao",
    ],
  },
];

const TOTAL_STEPS = STEPS.length;

interface Props {
  productionUnlocked: boolean;
  // ── Multi-CNPJ (todas opcionais — ausentes, o form opera EXATAMENTE como
  // antes, sobre a empresa padrão via /fiscal/config*). ──
  /** Empresa específica a editar (endpoints /fiscal/companies/:id*). */
  companyId?: string | null;
  /** Dados sanitizados da empresa (evita fetch — o manager já tem a lista). */
  initialCompany?: Record<string, any> | null;
  /** true = cadastro de CNPJ ADICIONAL (POST /fiscal/companies). */
  createMode?: boolean;
  /** Notifica o wrapper após salvar (para recarregar a lista). */
  onSaved?: () => void;
}

type ToastType = "success" | "error" | "warning";

export function FiscalConfigForm({
  productionUnlocked,
  companyId = null,
  initialCompany = null,
  createMode = false,
  onSaved,
}: Props) {
  const { data: session } = useSession();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(
    null,
  );
  const [certStatus, setCertStatus] = useState<CertificateStatus | null>(null);
  const [configExists, setConfigExists] = useState(false);
  const [providerTokenConfigured, setProviderTokenConfigured] = useState(false);
  // NFC-e (Fase 2): CSC salvo? (segredo nunca volta — só o booleano)
  const [cscConfigured, setCscConfigured] = useState(false);

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

  // Aplica uma config (do GET legado ou do manager multi-CNPJ) ao formulário
  // — extraído para os dois caminhos nunca divergirem.
  const applyConfigToForm = (config: Record<string, any>) => {
    setConfigExists(Boolean(config.cnpj));
    setProviderTokenConfigured(Boolean(config.providerTokenConfigurado));
    setCscConfigured(Boolean(config.cscConfigurado));
    setCertStatus({
      configured: Boolean(config.certificadoConfigurado),
      validoAte: config.certificadoValidoAte ?? null,
      subjectCN: config.certificadoSubjectCN ?? null,
      // null (sem cert) → undefined; false (cert não confirmado) → false,
      // preservando o aviso de risco através de reloads.
      cnpjMatched: config.certificadoCnpjConfirmado ?? undefined,
    });
    reset({
      ...DEFAULT_FISCAL_CONFIG,
      ...config,
      cnpj: config.cnpj ?? "",
      nomeFantasia: config.nomeFantasia ?? "",
      inscricaoMunicipal: config.inscricaoMunicipal ?? "",
      cnae: config.cnae ?? "",
      // NFC-e (Fase 2): cscToken NUNCA volta do backend — campo começa
      // vazio (vazio = preserva o salvo, padrão providerToken).
      serieNfce: config.serieNfce ?? 1,
      cscId: config.cscId ?? "",
      cscToken: "",
      ncmPadrao: config.ncmPadrao ?? "",
      cep: config.cep ?? "",
      logradouro: config.logradouro ?? "",
      numero: config.numero ?? "",
      complemento: config.complemento ?? "",
      bairro: config.bairro ?? "",
      municipio: config.municipio ?? "",
      codMunicipio: config.codMunicipio ?? "",
      uf: config.uf ?? "",
      providerName: config.providerName ?? "FOCUS_NFE",
      providerToken: config.providerToken ?? "",
      serieNfe: config.serieNfe ?? 1,
    });
  };

  useEffect(() => {
    // Multi-CNPJ: cadastro de empresa nova — form vazio, sem fetch.
    if (createMode) {
      setIsLoading(false);
      return;
    }
    // Multi-CNPJ: empresa específica — dados vêm do manager (sem GET próprio;
    // não existe GET /companies/:id, a lista já é sanitizada).
    if (companyId && initialCompany) {
      applyConfigToForm(initialCompany);
      setIsLoading(false);
      return;
    }
    const load = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(`${getApiBaseUrl()}/fiscal/config`, {
          headers: { email: session.user.email },
        });
        if (!res.ok) throw new Error("Erro ao carregar configuração");
        const data = await res.json();
        if (data?.config) {
          applyConfigToForm(data.config);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.email, reset, companyId, createMode]);

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
      // Multi-CNPJ: destino conforme o modo — criação (POST /companies),
      // empresa específica (PUT /companies/:id) ou legado (PUT /config).
      const endpoint = createMode
        ? `${getApiBaseUrl()}/fiscal/companies`
        : companyId
          ? `${getApiBaseUrl()}/fiscal/companies/${companyId}`
          : `${getApiBaseUrl()}/fiscal/config`;
      const res = await fetch(endpoint, {
        method: createMode ? "POST" : "PUT",
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
      setConfigExists(true);
      // Token salvo se já havia um ou se um novo foi digitado agora (o backend
      // preserva o anterior quando o campo vai vazio).
      setProviderTokenConfigured((prev) => prev || Boolean(payload.providerToken));
      showToast(
        createMode
          ? "Empresa adicionada com sucesso!"
          : "Configuração fiscal salva com sucesso!",
        "success",
      );
      onSaved?.();
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
            userEmail={session?.user?.email}
            configExists={configExists}
            certStatus={certStatus}
            onCertUploaded={setCertStatus}
            providerTokenConfigured={providerTokenConfigured}
            cscConfigured={cscConfigured}
            companyId={companyId}
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
        <ToastViewport
          className={
            "fixed bottom-6 right-6 z-[100] rounded-xl border px-4 py-3 text-sm shadow-lg " +
            (toast.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : toast.type === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700")
          }
        >
          {toast.msg}
        </ToastViewport>
      )}
    </div>
  );
}
