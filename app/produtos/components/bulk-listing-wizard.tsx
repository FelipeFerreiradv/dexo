"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Megaphone,
  Settings2,
  ListChecks,
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  StepperHeader,
  type StepperStep,
} from "@/components/stepper/stepper-header";
import { StepperFooter } from "@/components/stepper/stepper-footer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { getApiBaseUrl } from "@/lib/api";
import {
  applyRules,
  computeBulkPrice,
  previewWarnings,
} from "@/app/marketplaces/services/bulk-listing-rules.service";
import { computeStaggeredPrices } from "@/app/marketplaces/services/cross-account-price.service";
import { useBulkListingJob } from "../hooks/use-bulk-listing-job";
import { usePerProductListing } from "./bulk-review/use-per-product-listing";
import { PerProductReviewStep } from "./bulk-review/per-product-review-step";
import {
  buildPerProductOverrides,
  type GlobalListingDefaults,
  type ReviewCategoryOption,
} from "./bulk-review/per-product-types";

type Platform = "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";

type WizardMode = "quick" | "review";

// Integração Magalu (3º marketplace) atrás da flag — quando off, o wizard fica
// idêntico ao de hoje (seção/contas Magalu ausentes; nenhum request MAGALU é
// emitido). Espelha o gate do modal create-product-dialog.tsx.
const MAGALU_ENABLED =
  process.env.NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED === "true";

interface MarketplaceAccountLite {
  id: string;
  accountName: string;
  status?: string;
}

export interface BulkListingProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  costPrice?: number | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  mlCategoryId?: string | null;
  shopeeCategoryId?: string | null;
  compatibilitiesCount?: number | null;
}

export interface BulkListingWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedProducts: BulkListingProduct[];
  email: string;
  onJobStarted?: (jobId: string) => void;
  onJobFinished?: (summary: { success: number; failed: number }) => void;
  onShowToast?: (msg: string, type: "success" | "warning" | "error") => void;
}

type PriceRuleType = "keep" | "fixed" | "markup_pct" | "delta_pct";

interface RulesForm {
  priceRuleType: PriceRuleType;
  priceRuleValue: number;
  titleSuffix: string;
  mlCategoryStrategy: "auto" | "from_product";
  mlListingType: string;
  mlItemCondition: string;
  mlFreeShipping: boolean;
  // Aumento percentual escalonado entre contas ML (anti-penalização).
  crossAccountIncrease: boolean;
  crossAccountPercent: number;
}

const DEFAULT_RULES: RulesForm = {
  priceRuleType: "keep",
  priceRuleValue: 0,
  titleSuffix: "",
  mlCategoryStrategy: "auto",
  mlListingType: "gold_special",
  mlItemCondition: "used",
  mlFreeShipping: false,
  crossAccountIncrease: false,
  crossAccountPercent: 0,
};

const STEPS: StepperStep[] = [
  {
    id: 1,
    title: "Marketplaces",
    description: "Selecione contas",
    icon: Megaphone,
  },
  {
    id: 2,
    title: "Regras",
    description: "Preço e estoque",
    icon: Settings2,
  },
  {
    id: 3,
    title: "Revisão",
    description: "Conferir antes",
    icon: ListChecks,
  },
  {
    id: 4,
    title: "Progresso",
    description: "Acompanhar criação",
    icon: Activity,
  },
];

// Mesmos ids/posições do fluxo rápido; só os rótulos das etapas 2 e 3 mudam para
// refletir o modo Revisão individual. Reaproveita StepAccounts/StepRules/
// StepProgress; só a etapa 3 troca de conteúdo.
const REVIEW_STEPS: StepperStep[] = [
  STEPS[0],
  {
    id: 2,
    title: "Defaults globais",
    description: "Pré-preenche cada produto",
    icon: Settings2,
  },
  {
    id: 3,
    title: "Revisão individual",
    description: "Produto a produto",
    icon: ListChecks,
  },
  STEPS[3],
];

export function BulkListingWizard({
  open,
  onOpenChange,
  selectedProducts,
  email,
  onJobStarted,
  onJobFinished,
  onShowToast,
}: BulkListingWizardProps) {
  const [step, setStep] = useState(1);
  const [mlAccounts, setMlAccounts] = useState<MarketplaceAccountLite[]>([]);
  const [shopeeAccounts, setShopeeAccounts] = useState<
    MarketplaceAccountLite[]
  >([]);
  const [magaluAccounts, setMagaluAccounts] = useState<
    MarketplaceAccountLite[]
  >([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedMlIds, setSelectedMlIds] = useState<Set<string>>(new Set());
  const [selectedShopeeIds, setSelectedShopeeIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedMagaluIds, setSelectedMagaluIds] = useState<Set<string>>(
    new Set(),
  );
  const [rules, setRules] = useState<RulesForm>(DEFAULT_RULES);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [parentJobIdForRetry, setParentJobIdForRetry] = useState<string | null>(
    null,
  );
  const [retrying, setRetrying] = useState(false);
  const [finishedNotified, setFinishedNotified] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  // Guardas por REF (imunes a stale-closure em código assíncrono): uma única
  // finalização da revisão em voo; e nenhum modal de confirmação reaberto
  // depois que um job desta sessão já foi disparado.
  const finalizeInFlightRef = useRef(false);
  const jobStartedRef = useRef(false);
  const [preflightIssues, setPreflightIssues] = useState<
    Array<{
      productId: string;
      code: "shopee_category_missing" | "shopee_category_not_leaf";
      message: string;
    }>
  >([]);

  // Modo do fluxo: "quick" (atual, default) ou "review" (Revisão individual).
  const [mode, setMode] = useState<WizardMode>("quick");
  // Opções de categoria (ML/Shopee), carregadas sob demanda no modo Revisão.
  const [mlOptions, setMlOptions] = useState<ReviewCategoryOption[]>([]);
  const [shopeeOptions, setShopeeOptions] = useState<ReviewCategoryOption[]>([]);

  // --- Estado do modo Revisão individual (camada de anúncio por produto) ---
  const globalMlIdsArr = useMemo(
    () => Array.from(selectedMlIds),
    [selectedMlIds],
  );
  const globalShopeeIdsArr = useMemo(
    () => Array.from(selectedShopeeIds),
    [selectedShopeeIds],
  );
  const globalMagaluIdsArr = useMemo(
    () => Array.from(selectedMagaluIds),
    [selectedMagaluIds],
  );
  const reviewProducts = useMemo(
    () =>
      selectedProducts.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        price: p.price,
        imageUrl: p.imageUrl,
        imageUrls: p.imageUrls,
        mlCategoryId: p.mlCategoryId,
        shopeeCategoryId: p.shopeeCategoryId,
      })),
    [selectedProducts],
  );
  const reviewDefaults: GlobalListingDefaults = useMemo(
    () => ({
      autoCategory: rules.mlCategoryStrategy === "auto",
      mlListingType: rules.mlListingType,
      mlItemCondition: rules.mlItemCondition,
      mlFreeShipping: rules.mlFreeShipping,
    }),
    [
      rules.mlCategoryStrategy,
      rules.mlListingType,
      rules.mlItemCondition,
      rules.mlFreeShipping,
    ],
  );
  const pp = usePerProductListing({
    products: reviewProducts,
    defaults: reviewDefaults,
    globalMlIds: globalMlIdsArr,
    globalShopeeIds: globalShopeeIdsArr,
    globalMagaluIds: globalMagaluIdsArr,
    mlOptions,
    email,
  });
  const {
    enterStep: ppEnterStep,
    goNext: ppGoNext,
    goBack: ppGoBack,
    finalizeFlush: ppFinalizeFlush,
    resetAll: ppResetAll,
  } = pp;

  // Reset wizard state when reopened
  useEffect(() => {
    if (open) {
      setStep(1);
      setMode("quick");
      setRules(DEFAULT_RULES);
      setSelectedMlIds(new Set());
      setSelectedShopeeIds(new Set());
      setSelectedMagaluIds(new Set());
      setSubmitError(null);
      setJobId(null);
      setParentJobIdForRetry(null);
      setFinishedNotified(false);
      setPreflightIssues([]);
      finalizeInFlightRef.current = false;
      jobStartedRef.current = false;
      setMlOptions([]);
      setShopeeOptions([]);
      ppResetAll();
    }
  }, [open, ppResetAll]);

  // Carrega categorias ML/Shopee sob demanda só ao CHEGAR na etapa de Revisão
  // individual (etapa 3) — espelha o lazy-load por etapa do modal e evita o
  // fetch de ~12k itens à toa no rápido E quando o usuário escolhe Revisão mas
  // abandona antes da etapa 3. A sugestão automática (enterStep) não depende
  // dessa lista; ela só é necessária p/ a busca manual do combobox.
  useEffect(() => {
    if (!open || mode !== "review" || step !== 3 || !email) return;
    let cancelled = false;
    (async () => {
      const base = getApiBaseUrl();
      try {
        if (selectedMlIds.size > 0 && mlOptions.length === 0) {
          const r = await fetch(`${base}/marketplace/ml/categories`, {
            headers: { email },
          });
          if (r.ok) {
            const d = await r.json();
            if (!cancelled && Array.isArray(d?.categories))
              setMlOptions(d.categories);
          }
        }
        if (selectedShopeeIds.size > 0 && shopeeOptions.length === 0) {
          const r = await fetch(`${base}/marketplace/shopee/categories`, {
            headers: { email },
          });
          if (r.ok) {
            const d = await r.json();
            if (!cancelled && Array.isArray(d?.categories))
              setShopeeOptions(d.categories);
          }
        }
      } catch {
        // fail-open: comboboxes caem no fallback estático / aviso de sync
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    mode,
    step,
    email,
    selectedMlIds,
    selectedShopeeIds,
    mlOptions.length,
    shopeeOptions.length,
  ]);

  // Se a seleção GLOBAL de contas mudar, zera as configs por produto para
  // re-semear com as contas atuais. Sem isso, o snapshot de contas congelado na
  // 1ª visita ficaria stale: adicionar uma conta nova depois de revisar produtos
  // faria o produto NÃO publicar nessa conta (over-poda silenciosa). As contas
  // só mudam na etapa 1 (StepAccounts), então o reset nunca ocorre com um painel
  // de produto visível.
  const reviewAccountsKey = useMemo(
    () =>
      [...globalMlIdsArr].sort().join(",") +
      "|" +
      [...globalShopeeIdsArr].sort().join(",") +
      "|" +
      [...globalMagaluIdsArr].sort().join(","),
    [globalMlIdsArr, globalShopeeIdsArr, globalMagaluIdsArr],
  );
  useEffect(() => {
    ppResetAll();
  }, [reviewAccountsKey, ppResetAll]);

  // Fetch marketplace accounts on mount of step 1
  useEffect(() => {
    if (!open || step !== 1 || !email) return;
    let cancelled = false;
    setAccountsLoading(true);
    Promise.all([
      fetch(`${getApiBaseUrl()}/marketplace/ml/accounts`, {
        headers: { email },
      })
        .then((r) => r.json())
        .catch(() => ({ accounts: [] })),
      fetch(`${getApiBaseUrl()}/marketplace/shopee/accounts`, {
        headers: { email },
      })
        .then((r) => r.json())
        .catch(() => ({ accounts: [] })),
      // Magalu só é buscado com a flag ligada; senão resolve vazio (sem request).
      MAGALU_ENABLED
        ? fetch(`${getApiBaseUrl()}/marketplace/magalu/accounts`, {
            headers: { email },
          })
            .then((r) => r.json())
            .catch(() => ({ accounts: [] }))
        : Promise.resolve({ accounts: [] }),
    ])
      .then(([ml, sh, mg]) => {
        if (cancelled) return;
        const mlAccs = Array.isArray(ml?.accounts)
          ? (ml.accounts as MarketplaceAccountLite[])
          : [];
        const shAccs = Array.isArray(sh?.accounts)
          ? (sh.accounts as MarketplaceAccountLite[])
          : [];
        const mgAccs = Array.isArray(mg?.accounts)
          ? (mg.accounts as MarketplaceAccountLite[])
          : [];
        setMlAccounts(mlAccs.filter((a) => a.status !== "INACTIVE"));
        setShopeeAccounts(shAccs.filter((a) => a.status !== "INACTIVE"));
        setMagaluAccounts(mgAccs.filter((a) => a.status !== "INACTIVE"));
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, step, email]);

  // Pré-preenche o percentual escalonado com o valor padrão das Preferências do
  // usuário. É só conveniência de UI (campo editável por publicação); o backend
  // é a fonte de verdade e revalida o valor final.
  useEffect(() => {
    if (!open || !email) return;
    let cancelled = false;
    fetch(`${getApiBaseUrl()}/users/me`, { headers: { email } })
      .then((r) => r.json())
      .then((u) => {
        if (cancelled) return;
        const pref = Number(u?.crossAccountPriceIncreasePercent);
        if (Number.isFinite(pref) && pref > 0) {
          setRules((r) => ({ ...r, crossAccountPercent: pref }));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, email]);

  const totalAccountsSelected =
    selectedMlIds.size + selectedShopeeIds.size + selectedMagaluIds.size;
  const totalListings =
    selectedProducts.length * Math.max(1, totalAccountsSelected);

  const buildRequests = (): Array<{
    platform: Platform;
    accountId: string;
    mlSettings?: Record<string, unknown>;
  }> => {
    const out: Array<{
      platform: Platform;
      accountId: string;
      mlSettings?: Record<string, unknown>;
    }> = [];
    for (const id of selectedMlIds) {
      out.push({
        platform: "MERCADO_LIVRE",
        accountId: id,
        mlSettings: {
          listingType: rules.mlListingType,
          itemCondition: rules.mlItemCondition,
          freeShipping: rules.mlFreeShipping,
        },
      });
    }
    for (const id of selectedShopeeIds) {
      out.push({ platform: "SHOPEE", accountId: id });
    }
    // Magalu: categoria resolvida no backend → request sem categoryId (espelha
    // Shopee). No modo Revisão, a categoria por produto vai em perProductOverrides.
    for (const id of selectedMagaluIds) {
      out.push({ platform: "MAGALU", accountId: id });
    }
    return out;
  };

  const buildOverrideTemplate = () => {
    const t: Record<string, unknown> = {};
    // Rastreia se há override "real" — mlCategoryStrategy sozinho não conta
    // (mantém o comportamento atual de não enviar template só por causa dela).
    let hasMeaningful = false;
    if (rules.priceRuleType !== "keep") {
      t.priceRule = {
        type: rules.priceRuleType,
        value: rules.priceRuleValue,
      };
      hasMeaningful = true;
    }
    if (rules.titleSuffix.trim()) {
      t.titleSuffix = rules.titleSuffix.trim();
      hasMeaningful = true;
    }
    // Aumento escalonado entre contas ML: envia só { enabled, percent }; o
    // backend resolve/valida o percentual e congela a ordem das contas.
    if (rules.crossAccountIncrease && rules.crossAccountPercent > 0) {
      t.crossAccountIncrease = {
        enabled: true,
        percent: rules.crossAccountPercent,
      };
      hasMeaningful = true;
    }
    t.mlCategoryStrategy = rules.mlCategoryStrategy;
    return hasMeaningful ? t : null;
  };

  /**
   * Valida as categorias Shopee no servidor. `categoryOverrides` (Revisão
   * individual) envia a categoria EFETIVA por produto — a que o dispatch vai
   * usar — para o preflight não reprovar pela persistida desatualizada.
   * RETORNA os issues para o caller decidir sobre o resultado FRESCO (o state
   * é assíncrono e serve só para a UI).
   */
  const runPreflight = async (
    categoryOverrides?: Record<string, string>,
  ): Promise<Array<{ productId: string; code: string; message: string }>> => {
    if (selectedShopeeIds.size === 0) {
      setPreflightIssues([]);
      return [];
    }
    setPreflightLoading(true);
    try {
      const firstShopee = selectedShopeeIds.values().next().value as
        | string
        | undefined;
      const res = await fetch(`${getApiBaseUrl()}/listings/bulk/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({
          shopeeAccountId: firstShopee,
          productIds: selectedProducts.map((p) => p.id),
          ...(categoryOverrides && Object.keys(categoryOverrides).length > 0
            ? { categoryOverrides }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "Falha no preflight");
      }
      const issues = Array.isArray(data?.issues) ? data.issues : [];
      setPreflightIssues(issues);
      return issues;
    } catch (e) {
      setPreflightIssues([]);
      setSubmitError(
        e instanceof Error
          ? `Preflight falhou: ${e.message}`
          : "Preflight falhou.",
      );
      return [];
    } finally {
      setPreflightLoading(false);
    }
  };

  const handleNext = async () => {
    if (step === 1) {
      if (totalAccountsSelected === 0) {
        setSubmitError("Selecione ao menos uma conta de marketplace.");
        return;
      }
      setSubmitError(null);
      setStep(2);
      return;
    }
    if (step === 2) {
      if (
        rules.priceRuleType === "fixed" &&
        (!rules.priceRuleValue || rules.priceRuleValue <= 0)
      ) {
        setSubmitError("Preço fixo deve ser maior que zero.");
        return;
      }
      setSubmitError(null);
      setStep(3);
      // Roda preflight ao entrar na revisão (categorias Shopee, etc.).
      void runPreflight();
      return;
    }
    if (step === 3) {
      // Só bloqueia quando NÃO há nenhum alvo válido de fallback: preflight é
      // exclusivo da Shopee; ML e Magalu publicam independentemente (Magalu
      // resolve a categoria no backend). Com a flag off, selectedMagaluIds está
      // sempre vazio ⇒ condição idêntica à de antes.
      const allShopeeBlocked =
        selectedShopeeIds.size > 0 &&
        preflightIssues.length > 0 &&
        preflightIssues.length === selectedProducts.length &&
        selectedMlIds.size === 0 &&
        selectedMagaluIds.size === 0;
      if (allShopeeBlocked) {
        setSubmitError(
          MAGALU_ENABLED
            ? "Todos os produtos têm categoria Shopee inválida e nenhuma conta ML ou Magalu está selecionada. Corrija antes de prosseguir."
            : "Todos os produtos têm categoria Shopee inválida e nenhuma conta ML está selecionada. Corrija antes de prosseguir.",
        );
        return;
      }
      setConfirmOpen(true);
    }
  };

  const handleBack = () => {
    if (step <= 1) return;
    setStep(step - 1);
  };

  // --- Navegação do modo Revisão individual (caminho paralelo ao rápido) ---
  const handleReviewNext = async () => {
    if (step === 1) {
      if (totalAccountsSelected === 0) {
        setSubmitError("Selecione ao menos uma conta de marketplace.");
        return;
      }
      setSubmitError(null);
      setStep(2);
      return;
    }
    if (step === 2) {
      if (
        rules.priceRuleType === "fixed" &&
        (!rules.priceRuleValue || rules.priceRuleValue <= 0)
      ) {
        setSubmitError("Preço fixo deve ser maior que zero.");
        return;
      }
      setSubmitError(null);
      setStep(3);
      ppEnterStep();
      // Mesmo preflight de categoria Shopee do fluxo rápido.
      void runPreflight();
      return;
    }
    if (step === 3) {
      // Avança produto a produto; só confirma no último.
      const advanced = ppGoNext();
      if (advanced) return;
      // REENTRÂNCIA/IDEMPOTÊNCIA: o caminho abaixo é assíncrono (re-preflight
      // no servidor). Com servidor lento + cliques repetidos no Finalizar,
      // várias invocações ficavam em voo e cada uma reabria o modal de
      // confirmação — inclusive DEPOIS do job já disparado, gerando um 2º job
      // que a Shopee rejeitava como duplicata (e que sobrescrevia o status
      // das linhas criadas com sucesso pelo 1º). Uma invocação por vez; nada
      // reabre o modal depois que um job desta sessão começou.
      if (finalizeInFlightRef.current || submitting || jobId) return;
      finalizeInFlightRef.current = true;
      try {
        await runFinalizePreflightAndConfirm();
      } finally {
        finalizeInFlightRef.current = false;
      }
      return;
    }
  };

  /** Passo final da revisão: re-preflight com as categorias efetivas + gate. */
  const runFinalizePreflightAndConfirm = async () => {
    {
      // Re-roda o preflight com as categorias EFETIVAS da revisão (as mesmas
      // que o dispatch envia via perProductOverrides). O preflight da entrada
      // da etapa validou a categoria PERSISTIDA no produto — para produto
      // nunca salvo com categoria Shopee, ele reprova mesmo com categoria
      // válida escolhida na tela. Decide sobre o resultado FRESCO retornado.
      const map = ppFinalizeFlush();
      const categoryOverrides: Record<string, string> = {};
      const excludedFromShopee = new Set<string>();
      for (const [productId, cfg] of Object.entries(map)) {
        if (cfg.includeShopee === false) {
          excludedFromShopee.add(productId);
          continue;
        }
        const cat = (cfg.shopeeCategory || "").trim();
        if (cat) categoryOverrides[productId] = cat;
      }
      const freshIssues = await runPreflight(categoryOverrides);
      // Se um job já começou enquanto o preflight estava em voo, NUNCA reabrir
      // a confirmação (era o mecanismo do duplo-submit em servidor lento).
      if (jobStartedRef.current) return;
      // Produto excluído da Shopee nesta revisão não vai para a Shopee — o
      // issue dele (pela persistida) não pode bloquear o lote.
      const blockingIssues = freshIssues.filter(
        (i) => !excludedFromShopee.has(i.productId),
      );
      // Só bloqueia quando NÃO há nenhum alvo válido de fallback: preflight é
      // exclusivo da Shopee; ML e Magalu publicam independentemente (Magalu
      // resolve a categoria no backend). Com a flag off, selectedMagaluIds está
      // sempre vazio ⇒ condição idêntica à de antes.
      const allShopeeBlocked =
        selectedShopeeIds.size > 0 &&
        blockingIssues.length > 0 &&
        blockingIssues.length ===
          selectedProducts.length - excludedFromShopee.size &&
        selectedMlIds.size === 0 &&
        selectedMagaluIds.size === 0;
      if (allShopeeBlocked) {
        setSubmitError(
          MAGALU_ENABLED
            ? "Todos os produtos têm categoria Shopee inválida e nenhuma conta ML ou Magalu está selecionada. Corrija antes de prosseguir."
            : "Todos os produtos têm categoria Shopee inválida e nenhuma conta ML está selecionada. Corrija antes de prosseguir.",
        );
        return;
      }
      setConfirmOpen(true);
    }
  };

  const handleReviewBack = () => {
    if (step === 1) return;
    if (step === 2) {
      setStep(1);
      return;
    }
    if (step === 3) {
      // Volta produto a produto; do primeiro produto, retorna à etapa Defaults.
      const wentBack = ppGoBack();
      if (!wentBack) setStep(2);
    }
  };

  const handleSubmit = async () => {
    // Idempotência: um job por sessão do wizard (o retry-failed tem botão
    // próprio). Cliques repetidos no "Sim" — ou um modal reaberto por engano —
    // não podem disparar um 2º job (a Shopee rejeita como duplicata e o
    // fracasso sobrescreve as linhas criadas com sucesso pelo 1º).
    if (submitting || jobStartedRef.current) return;
    jobStartedRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Template global (idêntico ao rápido). No modo Revisão, anexa os overrides
      // por produto DENTRO do template (campo aditivo; backend ignora se ausente).
      let overrideTemplate: Record<string, unknown> | null =
        buildOverrideTemplate();
      if (mode === "review") {
        const map = ppFinalizeFlush();
        const ppo = buildPerProductOverrides(
          map,
          globalMlIdsArr,
          globalShopeeIdsArr,
          globalMagaluIdsArr,
        );
        if (Object.keys(ppo).length > 0) {
          overrideTemplate = {
            ...(overrideTemplate ?? {}),
            perProductOverrides: ppo,
          };
        }
      }
      const res = await fetch(`${getApiBaseUrl()}/listings/bulk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          email,
        },
        body: JSON.stringify({
          productIds: selectedProducts.map((p) => p.id),
          requests: buildRequests(),
          overrideTemplate,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.jobId) {
        throw new Error(
          data?.message || data?.error || "Falha ao iniciar o job",
        );
      }
      setJobId(data.jobId as string);
      setParentJobIdForRetry(null);
      setStep(4);
      onJobStarted?.(data.jobId as string);
    } catch (e) {
      // Falha ao INICIAR o job → nenhum job existe; libera nova tentativa.
      jobStartedRef.current = false;
      setSubmitError(e instanceof Error ? e.message : "Erro ao iniciar job");
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  };

  const {
    snapshot,
    error: pollError,
    isPolling,
  } = useBulkListingJob(jobId, email);

  const isTerminal =
    !!snapshot &&
    (snapshot.status === "COMPLETED" ||
      snapshot.status === "FAILED_PARTIAL" ||
      snapshot.status === "FAILED");

  // Notify finished once
  useEffect(() => {
    if (!snapshot || !isTerminal || finishedNotified) return;
    setFinishedNotified(true);
    onJobFinished?.({
      success: snapshot.successItems,
      failed: snapshot.failedItems,
    });
    if (onShowToast) {
      if (snapshot.failedItems === 0) {
        onShowToast(
          `${snapshot.successItems} anúncio(s) criado(s) com sucesso!`,
          "success",
        );
      } else if (snapshot.successItems === 0) {
        onShowToast(
          `Falha ao criar anúncios: ${snapshot.failedItems} erro(s).`,
          "error",
        );
      } else {
        onShowToast(
          `${snapshot.successItems} criado(s), ${snapshot.failedItems} falharam.`,
          "warning",
        );
      }
    }
  }, [snapshot, isTerminal, finishedNotified, onJobFinished, onShowToast]);

  const handleRetryFailed = async () => {
    if (!jobId) return;
    setRetrying(true);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/listings/bulk/${jobId}/retry-failed`,
        {
          method: "POST",
          headers: { email },
        },
      );
      const data = await res.json();
      if (!res.ok || !data?.jobId) {
        throw new Error(data?.message || data?.error || "Falha ao reprocessar");
      }
      setParentJobIdForRetry(jobId);
      setJobId(data.jobId as string);
      setFinishedNotified(false);
      onJobStarted?.(data.jobId as string);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Erro ao reprocessar");
    } finally {
      setRetrying(false);
    }
  };

  const handleClose = () => {
    if (jobId && !isTerminal) {
      const ok = window.confirm(
        "O job ainda está em execução no servidor. Fechar agora não cancela o processamento. Continuar?",
      );
      if (!ok) return;
    }
    onOpenChange(false);
  };

  const productById = useMemo(() => {
    const m = new Map<string, BulkListingProduct>();
    for (const p of selectedProducts) m.set(p.id, p);
    return m;
  }, [selectedProducts]);

  // Contas ML selecionadas, em ordem de seleção (= ordem de inserção no Set).
  // Define a escada de preços: índice 0 = preço base. O backend congela a mesma
  // ordem (a partir da ordem dos requests) ao criar o job.
  const selectedMlAccountsOrdered = useMemo(
    () =>
      Array.from(selectedMlIds)
        .map((id) => mlAccounts.find((a) => a.id === id))
        .filter((a): a is MarketplaceAccountLite => !!a),
    [selectedMlIds, mlAccounts],
  );

  // Contas Shopee selecionadas (para o modo Revisão individual).
  const selectedShopeeAccountsSel = useMemo(
    () =>
      Array.from(selectedShopeeIds)
        .map((id) => shopeeAccounts.find((a) => a.id === id))
        .filter((a): a is MarketplaceAccountLite => !!a),
    [selectedShopeeIds, shopeeAccounts],
  );

  // Contas Magalu selecionadas (para o modo Revisão individual).
  const selectedMagaluAccountsSel = useMemo(
    () =>
      Array.from(selectedMagaluIds)
        .map((id) => magaluAccounts.find((a) => a.id === id))
        .filter((a): a is MarketplaceAccountLite => !!a),
    [selectedMagaluIds, magaluAccounts],
  );

  // Pendência de preflight do produto atualmente em revisão (badge no painel).
  const currentReviewProductId = pp.current?.id;
  const preflightIssueForCurrent = useMemo(() => {
    if (!currentReviewProductId) return undefined;
    const found = preflightIssues.find(
      (i) => i.productId === currentReviewProductId,
    );
    return found ? { code: found.code, message: found.message } : undefined;
  }, [currentReviewProductId, preflightIssues]);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) handleClose();
          else onOpenChange(true);
        }}
      >
        <DialogContent className="w-[98vw] max-w-[1600px] max-h-[96vh] overflow-y-auto sm:max-w-[98vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="size-5" />
              Anunciar em massa
            </DialogTitle>
            <DialogDescription>
              {selectedProducts.length} produto(s) selecionado(s).
            </DialogDescription>
          </DialogHeader>

          <StepperHeader
            steps={mode === "review" ? REVIEW_STEPS : STEPS}
            currentStep={step}
            onGoToStep={(s) => {
              if (jobId) return; // não permite voltar depois de disparar
              if (s < step) setStep(s);
            }}
          />

          {submitError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="inline size-4 mr-1" />
              {submitError}
            </div>
          )}

          <div className="min-h-[280px]">
            {step === 1 && (
              <ModeSelector
                mode={mode}
                onChange={(m) => {
                  setMode(m);
                  setSubmitError(null);
                }}
                disabled={!!jobId}
              />
            )}

            {step === 1 && (
              <StepAccounts
                loading={accountsLoading}
                mlAccounts={mlAccounts}
                shopeeAccounts={shopeeAccounts}
                magaluAccounts={magaluAccounts}
                selectedMlIds={selectedMlIds}
                selectedShopeeIds={selectedShopeeIds}
                selectedMagaluIds={selectedMagaluIds}
                onToggleMl={(id, checked) => {
                  setSelectedMlIds((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
                onToggleShopee={(id, checked) => {
                  setSelectedShopeeIds((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
                onToggleMagalu={(id, checked) => {
                  setSelectedMagaluIds((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
              />
            )}

            {step === 2 && (
              <StepRules
                rules={rules}
                setRules={setRules}
                mlSelectedCount={selectedMlIds.size}
              />
            )}

            {step === 3 && mode === "quick" && (
              <StepReview
                products={selectedProducts}
                rules={rules}
                totalListings={totalListings}
                accountsCount={totalAccountsSelected}
                hasMl={selectedMlIds.size > 0}
                hasShopee={selectedShopeeIds.size > 0}
                preflightLoading={preflightLoading}
                preflightIssues={preflightIssues}
                crossAccountAccounts={selectedMlAccountsOrdered}
              />
            )}

            {step === 3 && mode === "review" && (
              <PerProductReviewStep
                pp={pp}
                globalMlAccounts={selectedMlAccountsOrdered}
                globalShopeeAccounts={selectedShopeeAccountsSel}
                globalMagaluAccounts={selectedMagaluAccountsSel}
                mlOptions={mlOptions}
                shopeeOptions={shopeeOptions}
                magaluOptions={[]}
                preflightIssue={preflightIssueForCurrent}
                email={email}
              />
            )}

            {step === 4 && (
              <StepProgress
                snapshot={snapshot}
                pollError={pollError}
                isPolling={isPolling}
                productById={productById}
                parentJobIdForRetry={parentJobIdForRetry}
                retrying={retrying}
                onRetry={handleRetryFailed}
              />
            )}
          </div>

          {step < 4 && mode === "quick" && (
            <StepperFooter
              currentStep={step}
              totalSteps={3}
              isSubmitting={submitting}
              onBack={handleBack}
              onNext={handleNext}
              onSubmit={handleNext}
              submitLabel="Confirmar e criar"
            />
          )}

          {step < 4 && mode === "review" && (
            <StepperFooter
              currentStep={step}
              totalSteps={3}
              // preflightLoading: o Finalizar re-valida no servidor antes de
              // confirmar — desabilita o botão enquanto valida (servidor lento
              // + cliques repetidos geravam confirmações e jobs duplicados).
              isSubmitting={submitting || preflightLoading}
              onBack={handleReviewBack}
              onNext={handleReviewNext}
              onSubmit={handleReviewNext}
              submitLabel={
                step === 3 && pp.index < pp.total - 1 ? "Próximo" : "Finalizar"
              }
            />
          )}

          {step === 4 && (
            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
              <div className="text-xs text-muted-foreground">
                {isPolling && (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" />
                    Atualizando...
                  </span>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={!isTerminal && !!jobId}
              >
                {isTerminal ? "Fechar" : "Aguarde..."}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Criar {totalListings} anúncio(s)?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedProducts.length} produto(s) × {totalAccountsSelected}{" "}
              conta(s). Esta ação envia requisições reais aos marketplaces e não
              pode ser desfeita em massa. Verifique as regras antes de
              continuar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {submitting && <Loader2 className="size-4 animate-spin mr-1" />}
              Criar {totalListings}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* --------------------------- Seletor de modo --------------------------- */
function ModeSelector({
  mode,
  onChange,
  disabled,
}: {
  mode: WizardMode;
  onChange: (m: WizardMode) => void;
  disabled?: boolean;
}) {
  const options: Array<{ id: WizardMode; title: string; desc: string }> = [
    {
      id: "quick",
      title: "Rápido / em massa",
      desc: "Aplica as mesmas regras a todos os produtos de uma vez.",
    },
    {
      id: "review",
      title: "Revisão individual",
      desc: "Confira e ajuste cada anúncio, um por um, antes de publicar.",
    },
  ];
  return (
    <div className="mb-4 grid gap-2 sm:grid-cols-2">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.id)}
          className={`rounded-lg border p-3 text-left transition ${
            mode === opt.id
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "hover:bg-muted/50"
          } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
        >
          <p className="text-sm font-medium">{opt.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</p>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ Step 1 ------------------------------ */
function StepAccounts({
  loading,
  mlAccounts,
  shopeeAccounts,
  magaluAccounts,
  selectedMlIds,
  selectedShopeeIds,
  selectedMagaluIds,
  onToggleMl,
  onToggleShopee,
  onToggleMagalu,
}: {
  loading: boolean;
  mlAccounts: MarketplaceAccountLite[];
  shopeeAccounts: MarketplaceAccountLite[];
  magaluAccounts: MarketplaceAccountLite[];
  selectedMlIds: Set<string>;
  selectedShopeeIds: Set<string>;
  selectedMagaluIds: Set<string>;
  onToggleMl: (id: string, checked: boolean) => void;
  onToggleShopee: (id: string, checked: boolean) => void;
  onToggleMagalu: (id: string, checked: boolean) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin mr-2" />
        Carregando contas conectadas...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AccountSection
        title="Mercado Livre"
        accounts={mlAccounts}
        selected={selectedMlIds}
        onToggle={onToggleMl}
        emptyHint="Nenhuma conta ML conectada. Conecte em Integrações."
      />
      <Separator />
      <AccountSection
        title="Shopee"
        accounts={shopeeAccounts}
        selected={selectedShopeeIds}
        onToggle={onToggleShopee}
        emptyHint="Nenhuma conta Shopee conectada. Conecte em Integrações."
      />
      {/* Magalu (3º marketplace) só aparece com a flag ligada. */}
      {MAGALU_ENABLED && (
        <>
          <Separator />
          <AccountSection
            title="Magalu"
            accounts={magaluAccounts}
            selected={selectedMagaluIds}
            onToggle={onToggleMagalu}
            emptyHint="Nenhuma conta Magalu conectada. Conecte em Integrações."
          />
        </>
      )}
    </div>
  );
}

function AccountSection({
  title,
  accounts,
  selected,
  onToggle,
  emptyHint,
}: {
  title: string;
  accounts: MarketplaceAccountLite[];
  selected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  emptyHint: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {selected.size > 0 && (
          <Badge variant="outline" className="font-normal">
            {selected.size} selecionada(s)
          </Badge>
        )}
      </div>
      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {accounts.map((acc) => (
            <label
              key={acc.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border bg-card px-3 py-2 hover:bg-muted/50"
            >
              <Checkbox
                checked={selected.has(acc.id)}
                onCheckedChange={(c) => onToggle(acc.id, !!c)}
              />
              <span className="text-sm">{acc.accountName}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Step 2 ------------------------------ */
function StepRules({
  rules,
  setRules,
  mlSelectedCount,
}: {
  rules: RulesForm;
  setRules: React.Dispatch<React.SetStateAction<RulesForm>>;
  mlSelectedCount: number;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {/* Preço */}
      <div className="space-y-2">
        <Label>Regra de preço</Label>
        <Select
          value={rules.priceRuleType}
          onValueChange={(v) =>
            setRules((r) => ({ ...r, priceRuleType: v as PriceRuleType }))
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="keep">Manter preço do produto</SelectItem>
            <SelectItem value="fixed">Preço fixo (R$)</SelectItem>
            <SelectItem value="markup_pct">Markup sobre custo (%)</SelectItem>
            <SelectItem value="delta_pct">
              Delta sobre preço atual (%)
            </SelectItem>
          </SelectContent>
        </Select>
        {rules.priceRuleType === "fixed" ? (
          // Preço fixo é monetário → CurrencyInput (BRL), igual ao "Preço de venda".
          <CurrencyInput
            value={rules.priceRuleValue || null}
            onChange={(v) =>
              setRules((r) => ({ ...r, priceRuleValue: v ?? 0 }))
            }
          />
        ) : rules.priceRuleType !== "keep" ? (
          // Markup/Delta são percentuais → input numérico normal (sem R$).
          <Input
            type="number"
            step="1"
            value={rules.priceRuleValue || ""}
            onChange={(e) =>
              setRules((r) => ({
                ...r,
                priceRuleValue: Number(e.target.value) || 0,
              }))
            }
            placeholder="Ex.: 30 (significa 30%)"
          />
        ) : null}
      </div>

      {/* Estoque (somente leitura — explicação) */}
      <div className="space-y-2">
        <Label className="text-muted-foreground">Estoque</Label>
        <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          O estoque é compartilhado entre todos os anúncios do produto e
          replicado pelo Sync — não é configurável por anúncio (evita oversell).
        </div>
      </div>

      {/* Sufixo no título */}
      <div className="space-y-2">
        <Label>Sufixo no título (opcional)</Label>
        <Input
          value={rules.titleSuffix}
          onChange={(e) =>
            setRules((r) => ({ ...r, titleSuffix: e.target.value }))
          }
          placeholder="Ex.: Original, Frete Grátis"
          maxLength={30}
        />
      </div>

      {/* Categoria ML */}
      <div className="space-y-2">
        <Label>Categoria Mercado Livre</Label>
        <Select
          value={rules.mlCategoryStrategy}
          onValueChange={(v) =>
            setRules((r) => ({
              ...r,
              mlCategoryStrategy: v as RulesForm["mlCategoryStrategy"],
            }))
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">
              Categoria automática (sugerir por produto)
            </SelectItem>
            <SelectItem value="from_product">
              Usar mlCategoryId do produto
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* mlSettings inline */}
      <div className="space-y-2">
        <Label>Tipo de anúncio (ML)</Label>
        <Select
          value={rules.mlListingType}
          onValueChange={(v) => setRules((r) => ({ ...r, mlListingType: v }))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bronze">Grátis (bronze)</SelectItem>
            <SelectItem value="gold_special">
              Clássico (gold_special)
            </SelectItem>
            <SelectItem value="gold_premium">Premium (gold_premium)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Condição (ML)</Label>
        <Select
          value={rules.mlItemCondition}
          onValueChange={(v) => setRules((r) => ({ ...r, mlItemCondition: v }))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">Novo</SelectItem>
            <SelectItem value="used">Usado</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2 pt-6">
        <Checkbox
          id="freeshipping"
          checked={rules.mlFreeShipping}
          onCheckedChange={(c) =>
            setRules((r) => ({ ...r, mlFreeShipping: !!c }))
          }
        />
        <Label htmlFor="freeshipping" className="cursor-pointer">
          Frete grátis (ML)
        </Label>
      </div>

      {/* Aumento percentual escalonado entre contas ML */}
      <div className="space-y-2 pt-2 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="crossaccount"
            checked={rules.crossAccountIncrease}
            onCheckedChange={(c) =>
              setRules((r) => ({ ...r, crossAccountIncrease: !!c }))
            }
          />
          <Label htmlFor="crossaccount" className="cursor-pointer">
            Aumentar percentual nas demais contas (Mercado Livre)
          </Label>
        </div>
        {rules.crossAccountIncrease && (
          <div className="space-y-2 rounded-md border border-dashed bg-muted/30 px-3 py-3">
            <div className="space-y-1">
              <Label
                htmlFor="crossaccountpct"
                className="text-xs text-muted-foreground"
              >
                Percentual de aumento composto entre contas
              </Label>
              <div className="relative w-full sm:w-48">
                <Input
                  id="crossaccountpct"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="0.01"
                  value={rules.crossAccountPercent || ""}
                  onChange={(e) =>
                    setRules((r) => ({
                      ...r,
                      crossAccountPercent: Number(e.target.value) || 0,
                    }))
                  }
                  placeholder="Ex.: 10"
                  className="pr-8"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  %
                </span>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Aplicado em cascata: a 1ª conta selecionada mantém o preço base;
              cada conta seguinte recebe este % sobre o preço da anterior.
              Confira o preview por conta na etapa de revisão.
            </p>
            {mlSelectedCount < 2 && (
              <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="inline size-3 mr-1" />
                Selecione 2 ou mais contas do Mercado Livre para o escalonamento
                ter efeito.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Step 3 ------------------------------ */
function StepReview({
  products,
  rules,
  totalListings,
  accountsCount,
  hasMl,
  hasShopee,
  preflightLoading,
  preflightIssues,
  crossAccountAccounts,
}: {
  products: BulkListingProduct[];
  rules: RulesForm;
  totalListings: number;
  accountsCount: number;
  hasMl: boolean;
  hasShopee: boolean;
  preflightLoading: boolean;
  preflightIssues: Array<{
    productId: string;
    code: "shopee_category_missing" | "shopee_category_not_leaf";
    message: string;
  }>;
  crossAccountAccounts: MarketplaceAccountLite[];
}) {
  const issueByProduct = new Map(preflightIssues.map((i) => [i.productId, i]));
  const template = {
    priceRule:
      rules.priceRuleType === "keep"
        ? undefined
        : ({
            type: rules.priceRuleType,
            value: rules.priceRuleValue,
          } as const),
    titleSuffix: rules.titleSuffix.trim() || undefined,
  };

  const issueCount = issueByProduct.size;
  const allBlocked =
    hasShopee && issueCount > 0 && issueCount === products.length;

  // Aumento escalonado: só tem efeito quando ligado, com % > 0 e ≥ 2 contas ML.
  const cascadeOn =
    rules.crossAccountIncrease &&
    rules.crossAccountPercent > 0 &&
    crossAccountAccounts.length >= 2;
  const MAX_PREVIEW_ACCOUNTS = 8;
  const previewAccounts = cascadeOn
    ? crossAccountAccounts.slice(0, MAX_PREVIEW_ACCOUNTS)
    : [];
  const hiddenAccounts = cascadeOn
    ? crossAccountAccounts.length - previewAccounts.length
    : 0;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        Serão criados <strong>{totalListings}</strong> anúncio(s) —{" "}
        {products.length} produto(s) × {accountsCount} conta(s).
      </div>

      {cascadeOn && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950">
          <p className="mb-1.5 font-medium text-amber-800 dark:text-amber-200">
            Aumento escalonado ativo —{" "}
            {formatPercent(rules.crossAccountPercent)} em cascata entre{" "}
            {crossAccountAccounts.length} contas ML
          </p>
          <ol className="space-y-0.5 text-amber-800/90 dark:text-amber-200/90">
            {previewAccounts.map((acc, i) => {
              const factor = Math.pow(1 + rules.crossAccountPercent / 100, i);
              return (
                <li key={acc.id}>
                  {i + 1}. {acc.accountName} —{" "}
                  {i === 0
                    ? "preço base"
                    : `+${formatPercent((factor - 1) * 100)} (×${factor.toFixed(4)})`}
                </li>
              );
            })}
            {hiddenAccounts > 0 && (
              <li className="italic">… +{hiddenAccounts} conta(s)</li>
            )}
          </ol>
        </div>
      )}

      {hasShopee && preflightLoading && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Validando categorias Shopee...
        </div>
      )}

      {!preflightLoading && issueCount > 0 && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            allBlocked
              ? "border-destructive/40 bg-destructive/5 text-destructive"
              : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          }`}
        >
          <AlertTriangle className="inline size-3.5 mr-1" />
          <strong>
            {issueCount} produto(s) com categoria Shopee inválida.
          </strong>{" "}
          {allBlocked
            ? "Não há produtos válidos para Shopee — corrija a categoria ou remova as contas Shopee."
            : "Esses produtos vão falhar na criação Shopee. Corrija a categoria do produto antes ou prossiga e eles aparecerão como erro no relatório."}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Nome</th>
              <th className="px-3 py-2 text-right">Preço atual</th>
              <th className="px-3 py-2 text-right">
                {cascadeOn ? "Preço por conta" : "Preço final"}
              </th>
              <th className="px-3 py-2">Avisos</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const newPrice = computeBulkPrice(
                {
                  id: p.id,
                  name: p.name,
                  price: p.price,
                  costPrice: p.costPrice,
                },
                template.priceRule,
              );
              const warnings = previewWarnings(
                {
                  id: p.id,
                  name: p.name,
                  price: p.price,
                  costPrice: p.costPrice,
                  imageUrl: p.imageUrl,
                  imageUrls: p.imageUrls,
                  mlCategoryId: p.mlCategoryId,
                  shopeeCategoryId: p.shopeeCategoryId,
                  compatibilitiesCount: p.compatibilitiesCount,
                },
                {
                  priceRule: template.priceRule,
                  titleSuffix: template.titleSuffix,
                },
                { hasMl, hasShopee },
              );
              const issue = issueByProduct.get(p.id);
              const rowClass = issue ? "border-t bg-destructive/5" : "border-t";
              return (
                <tr key={p.id} className={rowClass}>
                  <td className="px-3 py-2 font-mono text-xs">{p.sku}</td>
                  <td className="px-3 py-2 max-w-[280px] truncate">{p.name}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {formatCurrency(p.price)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    {cascadeOn ? (
                      <div className="space-y-0.5">
                        {computeStaggeredPrices(
                          newPrice ?? p.price,
                          crossAccountAccounts.length,
                          rules.crossAccountPercent,
                        )
                          .slice(0, MAX_PREVIEW_ACCOUNTS)
                          .map((pr, i) => (
                            <div
                              key={i}
                              className="flex items-center justify-end gap-2 text-xs"
                            >
                              <span className="text-muted-foreground">
                                C{i + 1}
                              </span>
                              <span className="tabular-nums">
                                {formatCurrency(pr)}
                              </span>
                            </div>
                          ))}
                        {hiddenAccounts > 0 && (
                          <div className="text-[10px] italic text-muted-foreground">
                            … +{hiddenAccounts}
                          </div>
                        )}
                      </div>
                    ) : newPrice !== null ? (
                      formatCurrency(newPrice)
                    ) : (
                      formatCurrency(p.price)
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {warnings.length === 0 && !issue ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {issue && (
                          <li className="text-destructive font-medium">
                            <XCircle className="inline size-3 mr-1" />
                            {issue.message}
                          </li>
                        )}
                        {warnings.map((w, i) => (
                          <li
                            key={i}
                            className="text-amber-700 dark:text-amber-400"
                          >
                            <AlertTriangle className="inline size-3 mr-1" />
                            {w}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------ Step 4 ------------------------------ */
function StepProgress({
  snapshot,
  pollError,
  isPolling,
  productById,
  parentJobIdForRetry,
  retrying,
  onRetry,
}: {
  snapshot: ReturnType<typeof useBulkListingJob>["snapshot"];
  pollError: string | null;
  isPolling: boolean;
  productById: Map<string, BulkListingProduct>;
  parentJobIdForRetry: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (!snapshot) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin mr-2" />
        Iniciando job...
        {pollError && (
          <span className="ml-2 text-destructive">{pollError}</span>
        )}
      </div>
    );
  }

  const pct =
    snapshot.totalItems > 0
      ? (snapshot.doneItems / snapshot.totalItems) * 100
      : 0;
  const isTerminal =
    snapshot.status === "COMPLETED" ||
    snapshot.status === "FAILED_PARTIAL" ||
    snapshot.status === "FAILED";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {snapshot.doneItems} / {snapshot.totalItems} processados
          </span>
          <span className="text-muted-foreground">
            <CheckCircle2 className="inline size-3.5 mr-1 text-emerald-600" />
            {snapshot.successItems}{" "}
            <XCircle className="inline size-3.5 ml-2 mr-1 text-destructive" />
            {snapshot.failedItems}
          </span>
        </div>
        <Progress value={pct} className="h-2" />
      </div>

      {parentJobIdForRetry && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Reprocessando itens do job anterior {parentJobIdForRetry.slice(0, 8)}…
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border max-h-[260px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground sticky top-0">
            <tr>
              <th className="px-3 py-2">Produto</th>
              <th className="px-3 py-2">Plataforma</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.results.map((r, i) => {
              const p = productById.get(r.productId);
              return (
                <tr
                  key={`${r.productId}-${r.platform}-${r.accountId}-${i}`}
                  className="border-t"
                >
                  <td className="px-3 py-2 max-w-[280px] truncate">
                    <span className="font-mono text-xs text-muted-foreground mr-1">
                      {p?.sku ?? r.productId.slice(0, 6)}
                    </span>
                    {p?.name ?? r.productId}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Badge variant="outline" className="font-normal">
                      {r.platform === "MERCADO_LIVRE"
                        ? "ML"
                        : r.platform === "SHOPEE"
                          ? "Shopee"
                          : "Magalu"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {r.success ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="size-3.5" />
                        Sucesso
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 text-destructive"
                        title={r.error}
                      >
                        <XCircle className="size-3.5" />
                        {r.error
                          ? r.error.length > 40
                            ? `${r.error.slice(0, 40)}…`
                            : r.error
                          : "Falhou"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {snapshot.results.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  {isPolling
                    ? "Aguardando primeiros resultados..."
                    : "Nenhum resultado registrado."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isTerminal && snapshot.failedItems > 0 && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onRetry}
            disabled={retrying}
            className="gap-2"
          >
            {retrying ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCw className="size-4" />
            )}
            Tentar novamente os falhos
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ helpers ------------------------------ */
function formatCurrency(v: number): string {
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatPercent(v: number): string {
  // Até 2 casas, sem zeros desnecessários (10 → "10%", 5,5 → "5,5%").
  return `${v.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

// silence unused import in some build modes
void applyRules;
