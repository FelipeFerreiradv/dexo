"use client";

import { useEffect, useState } from "react";
import {
  useForm,
  type Control,
  type FieldErrors,
  type UseFormSetValue,
  Controller,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarClock, FileText, Package, User as UserIcon } from "lucide-react";
import { useSession } from "next-auth/react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput, formatToBRL } from "@/components/ui/currency-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  StepperHeader,
  StepperStep,
} from "@/components/stepper/stepper-header";
import { StepperFooter } from "@/components/stepper/stepper-footer";
import { getApiBaseUrl } from "@/lib/api";

import {
  budgetSchema,
  DEFAULT_BUDGET_VALUES,
  BudgetFormData,
} from "../lib/budget-schema";
import type { FinanceEntryFormData } from "../lib/finance-schema";
import { CustomerStep } from "./steps/customer-step";
import { UnidadeSelect } from "./shared/unidade-select";
import {
  ProductPickerBlock,
  type ProductMeta,
} from "./shared/product-picker-block";
import type { CustomerOption } from "./shared/customer-combobox";

const STEPS: (StepperStep & { fields: (keyof BudgetFormData)[] })[] = [
  {
    id: 1,
    title: "Cliente",
    description: "Para quem é o orçamento",
    icon: UserIcon,
    fields: ["customerId", "newCustomerName"],
  },
  {
    id: 2,
    title: "Itens",
    description: "Produtos e itens manuais",
    icon: Package,
    fields: ["items", "document", "reason"],
  },
  {
    id: 3,
    title: "Condições",
    description: "Valor, validade e observações",
    icon: CalendarClock,
    fields: ["totalAmount", "validUntil", "notes", "unidadeId"],
  },
];

const TOTAL_STEPS = STEPS.length;

const VENDEDOR_NONE = "__none__";

interface Seller {
  id: string;
  name: string | null;
  email: string;
  isOwner: boolean;
}

interface BudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: Partial<BudgetFormData> & {
    id?: string;
    customer?: CustomerOption | null;
  };
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onSaved: () => void;
  // Vendedores (admin + colaboradores) vêm do pai (BudgetList) p/ não refazer
  // o GET /budgets/sellers a cada abertura do diálogo.
  sellers?: Seller[];
}

export function BudgetDialog({
  open,
  onOpenChange,
  initialData,
  onToast,
  onSaved,
  sellers = [],
}: BudgetDialogProps) {
  const { data: session } = useSession();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerOption | null>(initialData?.customer ?? null);

  const isEdit = !!initialData?.id;

  const form = useForm<BudgetFormData>({
    resolver: zodResolver(budgetSchema) as any,
    mode: "onChange",
    defaultValues: { ...DEFAULT_BUDGET_VALUES, ...initialData },
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

  // productMeta/scrapMeta vivem aqui (sobrevivem à navegação entre steps —
  // o step desmonta ao mudar). Mesma mecânica do FinanceDialog.
  const [productMeta, setProductMeta] = useState<Record<string, ProductMeta>>(
    {},
  );
  const [scrapMeta, setScrapMeta] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      reset({ ...DEFAULT_BUDGET_VALUES, ...initialData });
      setSelectedCustomer(initialData?.customer ?? null);
      setCurrentStep(1);
      const items = (initialData as any)?.items;
      if (Array.isArray(items) && items.length > 0) {
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
      setScrapMeta({});
    }
  }, [open, initialData, reset]);

  // No CREATE, atribui por padrão ao próprio usuário logado (match por e-mail),
  // assim que a lista de vendedores (vinda do pai) estiver disponível. No EDIT
  // mantém o vendedor já salvo. Vendedor é opcional.
  useEffect(() => {
    if (!open || isEdit) return;
    const email = session?.user?.email;
    if (!email || sellers.length === 0) return;
    if (getValues().vendedorId) return;
    const self = sellers.find((sl) => sl.email === email);
    if (self) setValue("vendedorId", self.id, { shouldDirty: false });
  }, [open, isEdit, sellers, session?.user?.email, getValues, setValue]);

  const validateCurrentStep = async () => {
    const fields = STEPS[currentStep - 1].fields;
    const ok = await trigger(fields);
    if (!ok) {
      const first = fields.map((f) => errors[f]?.message).filter(Boolean)[0];
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
      const { quickCreateCustomer, newCustomerName, newCustomerCpf, ...rest } =
        data;
      const payload: Record<string, unknown> = {
        ...rest,
        document: rest.document || null,
        reason: rest.reason || null,
        notes: rest.notes || null,
        unidadeId: rest.unidadeId || null,
        vendedorId: rest.vendedorId || null,
        validUntil: rest.validUntil ? rest.validUntil : null,
      };
      if (quickCreateCustomer) {
        payload.newCustomer = {
          name: (newCustomerName || "").trim(),
          cpf: newCustomerCpf ? newCustomerCpf : null,
        };
        delete payload.customerId;
      }
      // Replace de itens igual ao balcão: só envia items:[] (limpar) se o
      // orçamento JÁ tinha itens; senão omite (cria/edita sem itens).
      const hadItems =
        Array.isArray((initialData as any)?.items) &&
        (initialData as any).items.length > 0;
      if (
        Array.isArray((payload as any).items) &&
        (payload as any).items.length === 0 &&
        !(isEdit && hadItems)
      ) {
        delete payload.items;
      }
      const url = isEdit
        ? `${getApiBaseUrl()}/budgets/${initialData!.id}`
        : `${getApiBaseUrl()}/budgets`;
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
        throw new Error(result.error || "Erro ao salvar orçamento");
      onToast(
        isEdit
          ? "Orçamento atualizado com sucesso!"
          : "Orçamento criado com sucesso!",
        "success",
      );
      onSaved();
      onOpenChange(false);
    } catch (e) {
      onToast(
        e instanceof Error ? e.message : "Erro ao salvar orçamento",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  });

  const subtotal = computeSubtotal((getValues().items as any[]) || []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar orçamento" : "Novo orçamento"}</DialogTitle>
          <DialogDescription>
            Monte o orçamento do cliente em {TOTAL_STEPS} etapas. Ele fica salvo
            e pode ser convertido em venda depois.
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
                control={control as unknown as Control<FinanceEntryFormData>}
                errors={errors as unknown as FieldErrors<FinanceEntryFormData>}
                selected={selectedCustomer}
                onSelect={setSelectedCustomer}
                setValue={
                  setValue as unknown as UseFormSetValue<FinanceEntryFormData>
                }
                allowQuickCreate={!isEdit}
              />
            )}

            {currentStep === 2 && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <ProductPickerBlock
                  control={control as unknown as Control<FinanceEntryFormData>}
                  setValue={setValue as unknown as (n: any, v: any, o?: any) => void}
                  getValues={
                    getValues as unknown as () => FinanceEntryFormData
                  }
                  productMeta={productMeta}
                  setProductMeta={setProductMeta}
                  scrapMeta={scrapMeta}
                  setScrapMeta={setScrapMeta}
                  reasonPrefix="Orçamento — "
                  headerTitle="Itens do orçamento"
                  headerHint="Produtos do catálogo e/ou itens manuais. O estoque NÃO é baixado aqui — só ao converter em venda."
                />

                <div className="space-y-1">
                  <label className="text-sm font-medium">Nº do documento</label>
                  <Controller
                    control={control}
                    name="document"
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="Ex: ORC 1234"
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
                        placeholder="Ex: Orçamento de peças"
                      />
                    )}
                  />
                </div>
              </div>
            )}

            {currentStep === 3 && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1">
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
                  {subtotal > 0 && (
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() =>
                        setValue("totalAmount", subtotal, { shouldDirty: true })
                      }
                    >
                      Usar subtotal dos itens (R$ {formatToBRL(subtotal)})
                    </button>
                  )}
                  {errors.totalAmount && (
                    <p className="text-xs text-destructive">
                      {errors.totalAmount.message}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium">Válido até</label>
                  <Controller
                    control={control}
                    name="validUntil"
                    render={({ field }) => (
                      <Input
                        type="date"
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value)}
                      />
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    Opcional. Após esta data o orçamento aparece como expirado.
                  </p>
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-sm font-medium">Vendedor</label>
                  <Controller
                    control={control}
                    name="vendedorId"
                    render={({ field }) => (
                      <Select
                        value={field.value ? field.value : VENDEDOR_NONE}
                        onValueChange={(v) =>
                          field.onChange(v === VENDEDOR_NONE ? null : v)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Sem vendedor" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={VENDEDOR_NONE}>
                            Sem vendedor
                          </SelectItem>
                          {sellers.map((sl) => (
                            <SelectItem key={sl.id} value={sl.id}>
                              {sl.name || sl.email}
                              {sl.isOwner ? " (administrador)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    Opcional. Quem fez o orçamento (você ou um colaborador) —
                    usado nas estatísticas por vendedor.
                  </p>
                </div>

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
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-sm font-medium">Observações</label>
                  <Controller
                    control={control}
                    name="notes"
                    render={({ field }) => (
                      <Textarea
                        {...field}
                        value={field.value ?? ""}
                        placeholder="Condições, prazos, garantia... (sai no PDF)"
                        rows={3}
                      />
                    )}
                  />
                </div>

                <div className="md:col-span-2 flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 p-4">
                  <div className="flex items-center gap-3">
                    <FileText className="size-4 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      Após salvar, você pode imprimir o orçamento em PDF e
                      convertê-lo em uma venda (Conta a Receber) na lista.
                    </p>
                  </div>
                </div>
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
            submitLabel={isEdit ? "Atualizar orçamento" : "Criar orçamento"}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function computeSubtotal(items: any[]): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, it) => {
    const q = Number(it?.quantity) || 0;
    const p = Number(it?.unitPrice) || 0;
    return sum + q * p;
  }, 0);
}
