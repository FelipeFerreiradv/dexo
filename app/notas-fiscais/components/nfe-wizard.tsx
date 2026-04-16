"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  FileText,
  User,
  Package,
  Truck,
  Box,
  Receipt,
  CreditCard,
  Calculator,
  CheckCircle,
  Loader2,
  Save,
} from "lucide-react";
import { useSession } from "next-auth/react";

import {
  StepperHeader,
  StepperStep,
} from "@/components/stepper/stepper-header";
import { StepperFooter } from "@/components/stepper/stepper-footer";

import {
  nfeDraftFormSchema,
  stepInfoGeralSchema,
  stepDestinatarioSchema,
  stepProdutosSchema,
  type NfeDraftFormData,
} from "../lib/nfe-form-schema";
import { DEFAULT_NFE_DRAFT } from "../lib/nfe-defaults";
import { useNfeDraft } from "../hooks/use-nfe-draft";

import { StepInformacoesGerais } from "./steps/step-informacoes-gerais";
import { StepDestinatario } from "./steps/step-destinatario";
import { StepProdutos } from "./steps/step-produtos";

// Steps 1-3 nesta fase; steps 4-9 serão adicionados em F4
const STEPS: StepperStep[] = [
  { id: 1, title: "Informações", description: "Dados gerais da NF-e", icon: FileText },
  { id: 2, title: "Destinatário", description: "Dados do destinatário", icon: User },
  { id: 3, title: "Produtos", description: "Itens da nota", icon: Package },
  // F4 steps (placeholders — ficam disabled)
  { id: 4, title: "Frete", description: "Dados do frete", icon: Truck },
  { id: 5, title: "Volumes", description: "Volumes da nota", icon: Box },
  { id: 6, title: "Duplicatas", description: "Cobrança", icon: Receipt },
  { id: 7, title: "Pagamentos", description: "Formas de pagamento", icon: CreditCard },
  { id: 8, title: "Impostos", description: "Cálculos fiscais", icon: Calculator },
  { id: 9, title: "Finalizar", description: "Revisão e emissão", icon: CheckCircle },
];

const MAX_STEP_F3 = 3; // limite desta fase

type ToastType = "success" | "error" | "warning" | "info";

export function NfeWizard() {
  const { data: session } = useSession();
  const email = session?.user?.email ?? "";

  const [currentStep, setCurrentStep] = useState(1);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(
    null,
  );

  const form = useForm<NfeDraftFormData>({
    resolver: zodResolver(nfeDraftFormSchema) as any,
    mode: "onChange",
    defaultValues: DEFAULT_NFE_DRAFT,
  });

  const {
    control,
    trigger,
    getValues,
    setValue,
    reset,
    formState: { errors },
  } = form;

  const showToast = (msg: string, type: ToastType) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const { saving, lastSavedAt, createDraft, loadDraft, saveDraft, debouncedSave } =
    useNfeDraft({
      email,
      draftId,
      onSaved: () => showToast("Rascunho salvo", "info"),
    });

  // Create or load draft on mount
  useEffect(() => {
    if (!email) return;

    const init = async () => {
      setIsLoading(true);
      try {
        // Check for draftId in URL params
        const params = new URLSearchParams(window.location.search);
        const existingId = params.get("draft");

        if (existingId) {
          const draft = await loadDraft(existingId);
          if (draft) {
            setDraftId(existingId);
            populateFormFromDraft(draft);
            return;
          }
        }

        // Create new draft
        const newId = await createDraft();
        if (newId) {
          setDraftId(newId);
        } else {
          showToast(
            "Configure o emissor antes de criar uma NF-e.",
            "warning",
          );
        }
      } catch {
        showToast("Erro ao inicializar rascunho", "error");
      } finally {
        setIsLoading(false);
      }
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const populateFormFromDraft = (draft: any) => {
    const dest = draft.destinatarioJson ?? {};
    reset({
      serie: draft.serie ?? 1,
      tipoOperacao: draft.tipoOperacao ?? "SAIDA",
      finalidade: draft.finalidade ?? "NORMAL",
      destinoOperacao: draft.destinoOperacao ?? "INTERNA",
      naturezaOperacao: draft.naturezaOperacao ?? "VENDA DE MERCADORIA",
      indPresenca: draft.indPresenca ?? "NAO_SE_APLICA",
      intermediador: draft.intermediador,
      numeroPedido: draft.numeroPedido,
      dataEmissao: draft.dataEmissao
        ? new Date(draft.dataEmissao).toISOString().slice(0, 16)
        : null,
      dataSaida: draft.dataSaida
        ? new Date(draft.dataSaida).toISOString().slice(0, 16)
        : null,
      customerId: draft.customerId,
      destinatario: {
        tipoPessoa: dest.tipoPessoa ?? "PF",
        cpfCnpj: dest.cpfCnpj ?? "",
        nome: dest.nome ?? "",
        inscricaoEstadual: dest.inscricaoEstadual ?? null,
        email: dest.email ?? null,
        telefone: dest.telefone ?? null,
        cep: dest.cep ?? null,
        logradouro: dest.logradouro ?? null,
        numero: dest.numero ?? null,
        complemento: dest.complemento ?? null,
        bairro: dest.bairro ?? null,
        municipio: dest.municipio ?? null,
        codMunicipio: dest.codMunicipio ?? null,
        uf: dest.uf ?? null,
        codPais: dest.codPais ?? "1058",
        pais: dest.pais ?? "BRASIL",
      },
      itens: (draft.itens ?? []).map((item: any) => ({
        productId: item.productId,
        numero: item.numero,
        codigo: item.codigo,
        descricao: item.descricao,
        ncm: item.ncm,
        cfop: item.cfop,
        cest: item.cest,
        origem: item.origem ?? 0,
        unidade: item.unidade,
        quantidade: item.quantidade,
        valorUnitario: item.valorUnitario,
        valorTotal: item.valorTotal,
        desconto: item.desconto,
        observacoes: item.observacoes,
      })),
    });
  };

  // Step-level validation schemas
  const validateCurrentStep = async (): Promise<boolean> => {
    if (currentStep === 1) {
      return trigger([
        "serie",
        "tipoOperacao",
        "finalidade",
        "destinoOperacao",
        "naturezaOperacao",
        "indPresenca",
      ]);
    }
    if (currentStep === 2) {
      return trigger(["destinatario.cpfCnpj", "destinatario.nome"]);
    }
    if (currentStep === 3) {
      return trigger(["itens"]);
    }
    return true;
  };

  const saveCurrentStep = useCallback(() => {
    if (!draftId) return;
    const data = getValues();

    if (currentStep === 1) {
      saveDraft(draftId, {
        serie: data.serie,
        tipoOperacao: data.tipoOperacao,
        finalidade: data.finalidade,
        destinoOperacao: data.destinoOperacao,
        naturezaOperacao: data.naturezaOperacao,
        indPresenca: data.indPresenca,
        intermediador: data.intermediador,
        numeroPedido: data.numeroPedido,
        dataEmissao: data.dataEmissao,
        dataSaida: data.dataSaida,
      });
    } else if (currentStep === 2) {
      saveDraft(draftId, {
        customerId: data.customerId,
        destinatario: data.destinatario,
      } as any);
    } else if (currentStep === 3) {
      saveDraft(draftId, {
        itens: data.itens,
      } as any);
    }
  }, [draftId, currentStep, getValues, saveDraft]);

  const handleNext = async () => {
    const ok = await validateCurrentStep();
    if (!ok) {
      showToast("Corrija os campos obrigatórios antes de avançar", "warning");
      return;
    }
    saveCurrentStep();

    if (currentStep < MAX_STEP_F3) {
      setCurrentStep((s) => s + 1);
    } else {
      showToast(
        "Etapas 4-9 serão implementadas na próxima fase",
        "info",
      );
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      saveCurrentStep();
      setCurrentStep((s) => s - 1);
    }
  };

  const goToStep = (step: number) => {
    if (step < currentStep && step >= 1) {
      saveCurrentStep();
      setCurrentStep(step);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Carregando rascunho...
      </div>
    );
  }

  if (!draftId) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-6 text-center">
        <p className="text-sm text-amber-700">
          Configure o emissor fiscal antes de criar uma NF-e.
        </p>
        <a
          href="/notas-fiscais/configuracao"
          className="mt-2 inline-block text-sm font-medium text-primary underline"
        >
          Ir para configuração
        </a>
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

      <div className="min-h-[300px]">
        {currentStep === 1 && (
          <StepInformacoesGerais control={control} errors={errors} />
        )}
        {currentStep === 2 && (
          <StepDestinatario
            control={control}
            errors={errors}
            setValue={setValue}
            email={email}
          />
        )}
        {currentStep === 3 && (
          <StepProdutos
            control={control}
            errors={errors}
            setValue={setValue}
            getValues={getValues}
            email={email}
          />
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {saving && (
          <>
            <Save className="h-3 w-3 animate-pulse" />
            Salvando...
          </>
        )}
        {!saving && lastSavedAt && (
          <>
            <Save className="h-3 w-3" />
            Salvo {lastSavedAt.toLocaleTimeString("pt-BR")}
          </>
        )}
      </div>

      <StepperFooter
        currentStep={currentStep}
        totalSteps={MAX_STEP_F3}
        onBack={handleBack}
        onNext={handleNext}
        onSubmit={handleNext}
        submitLabel="Salvar e avançar"
      />

      {toast && (
        <div
          className={
            "fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm shadow-lg " +
            (toast.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : toast.type === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : toast.type === "warning"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                  : "border-blue-500/40 bg-blue-500/10 text-blue-600")
          }
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
