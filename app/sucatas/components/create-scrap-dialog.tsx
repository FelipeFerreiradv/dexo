"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { CurrencyInput } from "@/components/ui/currency-input";
import { MultiImageUpload } from "@/components/ui/multi-image-upload";
import { Car, Check, DollarSign, FileText, Image } from "lucide-react";
import { getApiBaseUrl } from "@/lib/api";
import {
  getVehicleBrands,
  getModelsForBrand,
  getYearsForModel,
  getVersionsForModel,
} from "@/app/lib/vehicle-catalog";

const PAYMENT_METHODS = [
  { value: "DINHEIRO", label: "Dinheiro" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "BOLETO", label: "Boleto bancário" },
  { value: "SEM_PAGAMENTO", label: "Sem pagamento" },
  { value: "PIX", label: "Pix" },
  { value: "CARTAO_CREDITO", label: "Cartão de crédito" },
  { value: "TRANSFERENCIA", label: "Transferência bancária" },
  { value: "DEPOSITO", label: "Depósito bancário" },
  { value: "OUTRO", label: "Outros" },
] as const;

const FREIGHT_MODES = [
  { value: "CIF", label: "CIF (por conta do remetente)" },
  { value: "FOB", label: "FOB (por conta do destinatário)" },
  { value: "TERCEIROS", label: "Por conta de terceiros" },
  { value: "SEM_FRETE", label: "Sem frete" },
] as const;

const ISSUE_PURPOSES = [
  { value: "NORMAL", label: "Normal" },
  { value: "COMPLEMENTAR", label: "Complementar" },
  { value: "AJUSTE", label: "Ajuste" },
  { value: "DEVOLUCAO", label: "Devolução" },
] as const;

const STATUS_OPTIONS = [
  { value: "AVAILABLE", label: "Disponível" },
  { value: "IN_USE", label: "Em uso" },
  { value: "DEPLETED", label: "Esgotada" },
  { value: "ARCHIVED", label: "Arquivada" },
] as const;

interface LocationOption {
  id: string;
  code: string;
  fullPath: string;
}

interface ScrapFormData {
  brand: string;
  model: string;
  year: string;
  version: string;
  color: string;
  plate: string;
  chassis: string;
  engineNumber: string;
  renavam: string;
  lot: string;
  deregistrationCert: string;
  cost: number | null;
  paymentMethod: string;
  locationId: string;
  ncm: string;
  supplierCnpj: string;
  accessKey: string;
  issueDate: string;
  entryDate: string;
  nfeNumber: string;
  nfeProtocol: string;
  operationNature: string;
  nfeSeries: string;
  fiscalModel: string;
  icmsValue: number | null;
  icmsCtValue: number | null;
  freightMode: string;
  issuePurpose: string;
  imageUrls: string[];
  status: string;
  notes: string;
}

const EMPTY_FORM: ScrapFormData = {
  brand: "",
  model: "",
  year: "",
  version: "",
  color: "",
  plate: "",
  chassis: "",
  engineNumber: "",
  renavam: "",
  lot: "",
  deregistrationCert: "",
  cost: null,
  paymentMethod: "",
  locationId: "",
  ncm: "",
  supplierCnpj: "",
  accessKey: "",
  issueDate: "",
  entryDate: "",
  nfeNumber: "",
  nfeProtocol: "",
  operationNature: "",
  nfeSeries: "",
  fiscalModel: "",
  icmsValue: null,
  icmsCtValue: null,
  freightMode: "",
  issuePurpose: "",
  imageUrls: [],
  status: "AVAILABLE",
  notes: "",
};

const STEPS = [
  { id: 1, value: "veiculo", title: "Veículo", icon: Car },
  { id: 2, value: "financeiro", title: "Financeiro", icon: DollarSign },
  { id: 3, value: "fiscal", title: "Dados Fiscais", icon: FileText },
  { id: 4, value: "imagens", title: "Imagens", icon: Image },
] as const;

const TOTAL_STEPS = STEPS.length;

interface CreateScrapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editData?: any | null;
  onSuccess: () => void;
}

export function CreateScrapDialog({
  open,
  onOpenChange,
  editData,
  onSuccess,
}: CreateScrapDialogProps) {
  const { data: session } = useSession();
  const [form, setForm] = useState<ScrapFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const hasLoadedLocationsRef = useRef(false);
  const [currentStep, setCurrentStep] = useState(1);

  const isEdit = !!editData;

  // Vehicle catalog cascading
  const brands = getVehicleBrands();
  const models = form.brand ? getModelsForBrand(form.brand) : [];
  const years =
    form.brand && form.model ? getYearsForModel(form.brand, form.model) : [];
  const versions =
    form.brand && form.model ? getVersionsForModel(form.brand, form.model) : [];

  // Load locations
  const userEmail = session?.user?.email;

  useEffect(() => {
    if (!open || !userEmail || hasLoadedLocationsRef.current) return;
    hasLoadedLocationsRef.current = true;

    const load = async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/locations/select`, {
          headers: { email: userEmail! },
        });
        if (res.ok) {
          const data = await res.json();
          setLocations(
            Array.isArray(data.locations)
              ? data.locations
              : Array.isArray(data)
                ? data
                : [],
          );
        }
      } catch {
        // Silently ignore
      }
    };
    load();
  }, [open, userEmail]);

  // Populate form when editing
  useEffect(() => {
    if (editData) {
      setForm({
        brand: editData.brand || "",
        model: editData.model || "",
        year: editData.year || "",
        version: editData.version || "",
        color: editData.color || "",
        plate: editData.plate || "",
        chassis: editData.chassis || "",
        engineNumber: editData.engineNumber || "",
        renavam: editData.renavam || "",
        lot: editData.lot || "",
        deregistrationCert: editData.deregistrationCert || "",
        cost: editData.cost ?? null,
        paymentMethod: editData.paymentMethod || "",
        locationId: editData.locationId || "",
        ncm: editData.ncm || "",
        supplierCnpj: editData.supplierCnpj || "",
        accessKey: editData.accessKey || "",
        issueDate: editData.issueDate
          ? editData.issueDate.substring(0, 10)
          : "",
        entryDate: editData.entryDate
          ? editData.entryDate.substring(0, 10)
          : "",
        nfeNumber: editData.nfeNumber || "",
        nfeProtocol: editData.nfeProtocol || "",
        operationNature: editData.operationNature || "",
        nfeSeries: editData.nfeSeries || "",
        fiscalModel: editData.fiscalModel || "",
        icmsValue: editData.icmsValue ?? null,
        icmsCtValue: editData.icmsCtValue ?? null,
        freightMode: editData.freightMode || "",
        issuePurpose: editData.issuePurpose || "",
        imageUrls: editData.imageUrls || [],
        status: editData.status || "AVAILABLE",
        notes: editData.notes || "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setError(null);
    setCurrentStep(1);
  }, [editData, open]);

  const updateField = useCallback(
    <K extends keyof ScrapFormData>(key: K, value: ScrapFormData[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const progressPercentage = (currentStep / TOTAL_STEPS) * 100;

  const goToStep = (step: number) => {
    if (step < currentStep) {
      setCurrentStep(step);
    }
  };

  const handleNext = () => {
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleSubmit = async () => {
    if (!session?.user?.email) return;
    if (!form.brand.trim()) {
      setError("Marca é obrigatória");
      return;
    }
    if (!form.model.trim()) {
      setError("Modelo é obrigatório");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const apiBase = getApiBaseUrl();
      const payload: any = {
        brand: form.brand,
        model: form.model,
        year: form.year || undefined,
        version: form.version || undefined,
        color: form.color || undefined,
        plate: form.plate || undefined,
        chassis: form.chassis || undefined,
        engineNumber: form.engineNumber || undefined,
        renavam: form.renavam || undefined,
        lot: form.lot || undefined,
        deregistrationCert: form.deregistrationCert || undefined,
        cost: form.cost ?? undefined,
        paymentMethod: form.paymentMethod || undefined,
        locationId: form.locationId || undefined,
        ncm: form.ncm || undefined,
        supplierCnpj: form.supplierCnpj || undefined,
        accessKey: form.accessKey || undefined,
        issueDate: form.issueDate || undefined,
        entryDate: form.entryDate || undefined,
        nfeNumber: form.nfeNumber || undefined,
        nfeProtocol: form.nfeProtocol || undefined,
        operationNature: form.operationNature || undefined,
        nfeSeries: form.nfeSeries || undefined,
        fiscalModel: form.fiscalModel || undefined,
        icmsValue: form.icmsValue ?? undefined,
        icmsCtValue: form.icmsCtValue ?? undefined,
        freightMode: form.freightMode || undefined,
        issuePurpose: form.issuePurpose || undefined,
        imageUrls: form.imageUrls.length > 0 ? form.imageUrls : undefined,
        status: form.status || undefined,
        notes: form.notes || undefined,
      };

      const url = isEdit
        ? `${apiBase}/scraps/${editData.id}`
        : `${apiBase}/scraps`;
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "Erro ao salvar sucata");
        return;
      }

      onSuccess();
    } catch (err) {
      setError("Erro de conexão ao salvar sucata");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar Sucata" : "Nova Sucata"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Atualize os dados da sucata cadastrada."
              : "Preencha os dados do veículo sucateado, informações fiscais e de custo."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Progress value={progressPercentage} className="h-2" />
          <div className="flex justify-between gap-1">
            {STEPS.map((step) => {
              const StepIcon = step.icon;
              const isActive = step.id === currentStep;
              const isCompleted = step.id < currentStep;
              const isClickable = step.id < currentStep;

              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => goToStep(step.id)}
                  disabled={!isClickable}
                  className={`flex flex-col items-center gap-1 transition-colors min-w-0 flex-1 ${
                    isClickable ? "cursor-pointer" : "cursor-default"
                  }`}
                >
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : isCompleted
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-muted-foreground/30 text-muted-foreground/50"
                    }`}
                  >
                    {isCompleted ? (
                      <Check className="h-5 w-5" />
                    ) : (
                      <StepIcon className="h-5 w-5" />
                    )}
                  </div>
                  <span
                    className={`text-[11px] leading-tight font-medium text-center wrap-break-word max-w-20 ${
                      isActive
                        ? "text-primary"
                        : isCompleted
                          ? "text-primary/80"
                          : "text-muted-foreground/50"
                    }`}
                  >
                    {step.title}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="text-sm font-medium text-muted-foreground">
            Etapa {currentStep} de {TOTAL_STEPS}
          </div>

          {/* Step 1: Veículo */}
          {currentStep === 1 && (
            <div className="space-y-4 pt-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>
                    Marca <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={form.brand}
                    onValueChange={(v) => {
                      updateField("brand", v);
                      updateField("model", "");
                      updateField("year", "");
                      updateField("version", "");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a marca" />
                    </SelectTrigger>
                    <SelectContent>
                      {brands.map((b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>
                    Modelo <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={form.model}
                    onValueChange={(v) => {
                      updateField("model", v);
                      updateField("year", "");
                      updateField("version", "");
                    }}
                    disabled={!form.brand}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o modelo" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Ano</Label>
                  <Select
                    value={form.year}
                    onValueChange={(v) => updateField("year", v)}
                    disabled={!form.model}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o ano" />
                    </SelectTrigger>
                    <SelectContent>
                      {years.map((y) => (
                        <SelectItem key={y} value={String(y)}>
                          {y}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Versão</Label>
                  <Select
                    value={form.version}
                    onValueChange={(v) => updateField("version", v)}
                    disabled={!form.model}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a versão" />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Cor</Label>
                  <Input
                    value={form.color}
                    onChange={(e) => updateField("color", e.target.value)}
                    placeholder="Ex: Preto"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Placa</Label>
                  <Input
                    value={form.plate}
                    onChange={(e) =>
                      updateField("plate", e.target.value.toUpperCase())
                    }
                    placeholder="ABC-1D23"
                    maxLength={8}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Chassi</Label>
                  <Input
                    value={form.chassis}
                    onChange={(e) =>
                      updateField("chassis", e.target.value.toUpperCase())
                    }
                    placeholder="17 caracteres"
                    maxLength={17}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Numeração do motor</Label>
                  <Input
                    value={form.engineNumber}
                    onChange={(e) =>
                      updateField("engineNumber", e.target.value)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Renavam</Label>
                  <Input
                    value={form.renavam}
                    onChange={(e) => updateField("renavam", e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Lote</Label>
                  <Input
                    value={form.lot}
                    onChange={(e) => updateField("lot", e.target.value)}
                  />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label>Certidão de baixa</Label>
                  <Input
                    value={form.deregistrationCert}
                    onChange={(e) =>
                      updateField("deregistrationCert", e.target.value)
                    }
                  />
                </div>
              </div>

              {isEdit && (
                <div className="space-y-2 pt-2">
                  <Label>Status</Label>
                  <Select
                    value={form.status}
                    onValueChange={(v) => updateField("status", v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>Observações</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) => updateField("notes", e.target.value)}
                  placeholder="Observações gerais sobre a sucata..."
                  rows={3}
                />
              </div>
            </div>
          )}

          {/* Step 2: Financeiro */}
          {currentStep === 2 && (
            <div className="space-y-4 pt-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Custo de aquisição</Label>
                  <CurrencyInput
                    value={form.cost}
                    onChange={(v) => updateField("cost", v)}
                    placeholder="0,00"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Forma de pagamento</Label>
                  <Select
                    value={form.paymentMethod}
                    onValueChange={(v) => updateField("paymentMethod", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione" />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((pm) => (
                        <SelectItem key={pm.value} value={pm.value}>
                          {pm.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label>Localização</Label>
                  <Select
                    value={form.locationId}
                    onValueChange={(v) => updateField("locationId", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a localização" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((loc) => (
                        <SelectItem key={loc.id} value={loc.id}>
                          {loc.fullPath}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Dados Fiscais */}
          {currentStep === 3 && (
            <div className="space-y-4 pt-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>NCM</Label>
                  <Input
                    value={form.ncm}
                    onChange={(e) => updateField("ncm", e.target.value)}
                    placeholder="0000.00.00"
                  />
                </div>

                <div className="space-y-2">
                  <Label>CNPJ do fornecedor</Label>
                  <Input
                    value={form.supplierCnpj}
                    onChange={(e) =>
                      updateField("supplierCnpj", e.target.value)
                    }
                    placeholder="00.000.000/0000-00"
                  />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label>Chave de acesso NF-e</Label>
                  <Input
                    value={form.accessKey}
                    onChange={(e) => updateField("accessKey", e.target.value)}
                    placeholder="44 dígitos"
                    maxLength={44}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Data de emissão</Label>
                  <Input
                    type="date"
                    value={form.issueDate}
                    onChange={(e) => updateField("issueDate", e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Data de entrada</Label>
                  <Input
                    type="date"
                    value={form.entryDate}
                    onChange={(e) => updateField("entryDate", e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Número da NF-e</Label>
                  <Input
                    value={form.nfeNumber}
                    onChange={(e) => updateField("nfeNumber", e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Protocolo</Label>
                  <Input
                    value={form.nfeProtocol}
                    onChange={(e) => updateField("nfeProtocol", e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Natureza de operação</Label>
                  <Input
                    value={form.operationNature}
                    onChange={(e) =>
                      updateField("operationNature", e.target.value)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Série</Label>
                  <Input
                    value={form.nfeSeries}
                    onChange={(e) => updateField("nfeSeries", e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Modelo fiscal</Label>
                  <Input
                    value={form.fiscalModel}
                    onChange={(e) => updateField("fiscalModel", e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Valor ICMS</Label>
                  <CurrencyInput
                    value={form.icmsValue}
                    onChange={(v) => updateField("icmsValue", v)}
                    placeholder="0,00"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Valor ICMS CT</Label>
                  <CurrencyInput
                    value={form.icmsCtValue}
                    onChange={(v) => updateField("icmsCtValue", v)}
                    placeholder="0,00"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Modalidade de frete</Label>
                  <Select
                    value={form.freightMode}
                    onValueChange={(v) => updateField("freightMode", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione" />
                    </SelectTrigger>
                    <SelectContent>
                      {FREIGHT_MODES.map((fm) => (
                        <SelectItem key={fm.value} value={fm.value}>
                          {fm.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Finalidade de emissão</Label>
                  <Select
                    value={form.issuePurpose}
                    onValueChange={(v) => updateField("issuePurpose", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione" />
                    </SelectTrigger>
                    <SelectContent>
                      {ISSUE_PURPOSES.map((ip) => (
                        <SelectItem key={ip.value} value={ip.value}>
                          {ip.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Imagens */}
          {currentStep === 4 && (
            <div className="space-y-4 pt-4">
              <MultiImageUpload
                value={form.imageUrls}
                onChange={(urls) => updateField("imageUrls", urls)}
                onError={(msg) => setError(msg)}
                maxImages={20}
              />
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <DialogFooter className="flex items-center justify-between">
          <Button
            variant="outline"
            onClick={currentStep === 1 ? () => onOpenChange(false) : handleBack}
            disabled={saving}
          >
            {currentStep === 1 ? "Cancelar" : "Voltar"}
          </Button>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              Etapa {currentStep} de {TOTAL_STEPS}
            </span>

            {currentStep < TOTAL_STEPS ? (
              <Button onClick={handleNext} disabled={saving}>
                Próximo
              </Button>
            ) : (
              <Button onClick={handleSubmit} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEdit ? "Salvar alterações" : "Cadastrar sucata"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
