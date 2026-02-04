"use client";

import { useState, useEffect, useCallback } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Plus,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Check,
  Package,
  DollarSign,
  Car,
  ClipboardCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { CurrencyInput } from "@/components/ui/currency-input";

// Schema de validação com campos de autopeças
const productSchema = z.object({
  // Step 1: Identificação
  sku: z
    .string()
    .min(1, "SKU é obrigatório")
    .max(50, "SKU deve ter no máximo 50 caracteres")
    .regex(
      /^[A-Za-z0-9-_]+$/,
      "SKU deve conter apenas letras, números, - ou _",
    ),
  name: z
    .string()
    .min(3, "Nome deve ter pelo menos 3 caracteres")
    .max(100, "Nome deve ter no máximo 100 caracteres"),
  description: z
    .string()
    .max(500, "Descrição deve ter no máximo 500 caracteres")
    .optional(),
  partNumber: z.string().max(100).optional().nullable(),

  // Step 2: Preços e Estoque
  price: z
    .number({ invalid_type_error: "Preço deve ser um número" })
    .min(0, "Preço deve ser maior ou igual a zero")
    .multipleOf(0.01, "Preço deve ter no máximo 2 casas decimais"),
  stock: z
    .number({ invalid_type_error: "Estoque deve ser um número" })
    .int("Estoque deve ser um número inteiro")
    .min(0, "Estoque deve ser maior ou igual a zero"),
  costPrice: z
    .number()
    .min(0, "Custo deve ser maior ou igual a zero")
    .optional()
    .nullable(),
  markup: z
    .number()
    .min(0, "Margem deve ser maior ou igual a zero")
    .optional()
    .nullable(),
  location: z.string().max(100).optional().nullable(),

  // Step 3: Veículo e Peça
  brand: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  year: z.string().max(20).optional().nullable(),
  version: z.string().max(100).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  quality: z
    .enum(["SUCATA", "SEMINOVO", "NOVO", "RECONDICIONADO"])
    .optional()
    .nullable(),
  isSecurityItem: z.boolean().optional(),
  isTraceable: z.boolean().optional(),
  sourceVehicle: z.string().max(200).optional().nullable(),
});

type ProductFormData = z.infer<typeof productSchema>;

interface CreateProductDialogProps {
  onProductCreated: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

const qualityOptions = [
  { value: "SUCATA", label: "Sucata" },
  { value: "SEMINOVO", label: "Seminovo" },
  { value: "NOVO", label: "Novo" },
  { value: "RECONDICIONADO", label: "Recondicionado" },
];

// Categorias do Mercado Livre - Acessórios para Veículos > Peças Automotivas
// Baseado nas categorias oficiais do ML Brasil
const ML_CATEGORIES = [
  {
    id: "MLB1747",
    value: "Motor e Peças",
    keywords: [
      "motor",
      "biela",
      "pistão",
      "virabrequim",
      "cabeçote",
      "bloco",
      "comando",
      "válvula",
      "junta",
    ],
  },
  {
    id: "MLB1748",
    value: "Suspensão",
    keywords: [
      "amortecedor",
      "mola",
      "bandeja",
      "pivô",
      "bieleta",
      "batente",
      "coifa",
      "bucha",
    ],
  },
  {
    id: "MLB1749",
    value: "Freios",
    keywords: [
      "freio",
      "disco",
      "pastilha",
      "pinça",
      "cilindro",
      "flexível",
      "tambor",
      "lona",
    ],
  },
  {
    id: "MLB1750",
    value: "Elétrica Automotiva",
    keywords: [
      "alternador",
      "motor de arranque",
      "bobina",
      "sensor",
      "módulo",
      "relé",
      "chicote",
      "farol",
      "lanterna",
      "seta",
    ],
  },
  {
    id: "MLB1751",
    value: "Arrefecimento",
    keywords: [
      "radiador",
      "bomba d'água",
      "válvula termostática",
      "ventoinha",
      "mangueira",
      "reservatório",
    ],
  },
  {
    id: "MLB1752",
    value: "Escapamento",
    keywords: [
      "escapamento",
      "catalisador",
      "silencioso",
      "coletor",
      "tubo",
      "flexível",
    ],
  },
  {
    id: "MLB1753",
    value: "Transmissão",
    keywords: [
      "câmbio",
      "embreagem",
      "platô",
      "disco",
      "atuador",
      "semi-eixo",
      "homocinética",
      "junta",
    ],
  },
  {
    id: "MLB1754",
    value: "Carroceria e Lataria",
    keywords: [
      "porta",
      "capô",
      "para-lama",
      "parachoque",
      "grade",
      "retrovisor",
      "maçaneta",
      "vidro",
      "fechadura",
    ],
  },
  {
    id: "MLB1755",
    value: "Direção",
    keywords: [
      "direção",
      "caixa de direção",
      "barra",
      "terminal",
      "braço",
      "setor",
      "bomba hidráulica",
    ],
  },
  {
    id: "MLB1756",
    value: "Injeção Eletrônica",
    keywords: [
      "bico",
      "injetor",
      "corpo de borboleta",
      "sonda",
      "sensor",
      "válvula",
      "regulador",
    ],
  },
  {
    id: "MLB1757",
    value: "Ignição",
    keywords: [
      "vela",
      "cabo de vela",
      "distribuidor",
      "bobina",
      "platinado",
      "condensador",
    ],
  },
  {
    id: "MLB1758",
    value: "Filtros",
    keywords: [
      "filtro de ar",
      "filtro de óleo",
      "filtro de combustível",
      "filtro de cabine",
      "elemento",
    ],
  },
  {
    id: "MLB1759",
    value: "Acessórios Internos",
    keywords: [
      "tapete",
      "banco",
      "volante",
      "manopla",
      "pedal",
      "console",
      "porta-objetos",
    ],
  },
  {
    id: "MLB1760",
    value: "Acessórios Externos",
    keywords: ["antena", "spoiler", "calha", "rack", "engate", "protetor"],
  },
  {
    id: "MLB1761",
    value: "Rodas e Pneus",
    keywords: ["roda", "pneu", "calota", "parafuso de roda", "válvula"],
  },
  {
    id: "MLB1762",
    value: "Alimentação de Combustível",
    keywords: [
      "bomba de combustível",
      "tanque",
      "boia",
      "mangueira",
      "regulador",
    ],
  },
  {
    id: "MLB1763",
    value: "Ar Condicionado Automotivo",
    keywords: [
      "compressor",
      "condensador",
      "evaporador",
      "filtro secador",
      "válvula de expansão",
    ],
  },
  { id: "MLB1764", value: "Outros", keywords: [] },
];

/**
 * Sugere categoria baseada no título do produto
 */
function suggestCategory(title: string): string | null {
  if (!title) return null;

  const titleLower = title.toLowerCase();

  for (const category of ML_CATEGORIES) {
    for (const keyword of category.keywords) {
      if (titleLower.includes(keyword.toLowerCase())) {
        return category.value;
      }
    }
  }

  return null;
}

// Configuração dos steps
const STEPS = [
  {
    id: 1,
    title: "Identificação",
    description: "Dados básicos do produto",
    icon: Package,
    fields: ["sku", "name", "description", "partNumber"],
  },
  {
    id: 2,
    title: "Preços e Estoque",
    description: "Valores e quantidade",
    icon: DollarSign,
    fields: ["price", "stock", "costPrice", "markup", "location"],
  },
  {
    id: 3,
    title: "Veículo e Peça",
    description: "Dados de autopeças",
    icon: Car,
    fields: [
      "brand",
      "model",
      "year",
      "version",
      "category",
      "quality",
      "isSecurityItem",
      "isTraceable",
      "sourceVehicle",
    ],
  },
  {
    id: 4,
    title: "Revisão",
    description: "Confirme os dados",
    icon: ClipboardCheck,
    fields: [],
  },
];

const TOTAL_STEPS = STEPS.length;

export function CreateProductDialog({
  onProductCreated,
  onToast,
}: CreateProductDialogProps) {
  const [open, setOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingSku, setIsLoadingSku] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
    setValue,
    watch,
    trigger,
  } = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      sku: "",
      name: "",
      description: "",
      partNumber: "",
      price: 0,
      stock: 0,
      costPrice: null,
      markup: null,
      location: "",
      brand: "",
      model: "",
      year: "",
      version: "",
      category: "",
      quality: null,
      isSecurityItem: false,
      isTraceable: false,
      sourceVehicle: "",
    },
  });

  // Watch all form values for review step
  const formValues = watch();

  // Watch específicos para cálculos automáticos
  const watchName = watch("name");
  const watchPartNumber = watch("partNumber");
  const watchCostPrice = watch("costPrice");
  const watchPrice = watch("price");

  // Busca próximo SKU ao abrir o dialog
  const fetchNextSku = useCallback(async () => {
    setIsLoadingSku(true);
    try {
      const response = await fetch("http://localhost:3333/products/next-sku");
      if (response.ok) {
        const data = await response.json();
        setValue("sku", data.sku);
      }
    } catch (error) {
      console.error("Erro ao buscar SKU:", error);
    } finally {
      setIsLoadingSku(false);
    }
  }, [setValue]);

  // Busca SKU quando dialog abre
  useEffect(() => {
    if (open) {
      fetchNextSku();
    }
  }, [open, fetchNextSku]);

  // Gera descrição automática baseada no nome e part number
  useEffect(() => {
    if (watchName) {
      let description = watchName;
      if (watchPartNumber) {
        description += `\nPart Number: ${watchPartNumber}`;
      }
      setValue("description", description);
    }
  }, [watchName, watchPartNumber, setValue]);

  // Calcula margem automaticamente (Preço Venda - Preço Custo) / Preço Custo * 100
  useEffect(() => {
    if (watchCostPrice && watchPrice && watchCostPrice > 0) {
      const markup = ((watchPrice - watchCostPrice) / watchCostPrice) * 100;
      setValue("markup", Math.round(markup * 100) / 100); // 2 casas decimais
    }
  }, [watchCostPrice, watchPrice, setValue]);

  // Sugere categoria baseada no nome do produto (sempre atualiza quando nome muda)
  useEffect(() => {
    if (watchName) {
      const suggested = suggestCategory(watchName);
      // Sempre atualiza a categoria quando o nome muda
      setValue("category", suggested || "");
    }
  }, [watchName, setValue]);

  const progressPercentage = (currentStep / TOTAL_STEPS) * 100;

  const onSubmit = async (data: ProductFormData) => {
    setIsSubmitting(true);
    try {
      // Limpar campos vazios/nulos antes de enviar
      const cleanData = {
        ...data,
        costPrice: data.costPrice || undefined,
        markup: data.markup || undefined,
        brand: data.brand || undefined,
        model: data.model || undefined,
        year: data.year || undefined,
        version: data.version || undefined,
        category: data.category || undefined,
        location: data.location || undefined,
        partNumber: data.partNumber || undefined,
        quality: data.quality || undefined,
        sourceVehicle: data.sourceVehicle || undefined,
      };

      const response = await fetch("http://localhost:3333/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cleanData),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Erro ao criar produto");
      }

      onToast("Produto criado com sucesso!", "success");
      handleClose();
      onProductCreated();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Erro ao criar produto",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    reset();
    setCurrentStep(1);
    setOpen(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      handleClose();
    }
    setOpen(newOpen);
  };

  // Validar campos do step atual antes de avançar
  const validateCurrentStep = async () => {
    const currentStepConfig = STEPS[currentStep - 1];
    const fieldsToValidate =
      currentStepConfig.fields as (keyof ProductFormData)[];

    if (fieldsToValidate.length === 0) return true;

    const isValid = await trigger(fieldsToValidate);
    return isValid;
  };

  const handleNext = async () => {
    const isValid = await validateCurrentStep();
    if (isValid && currentStep < TOTAL_STEPS) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const goToStep = (step: number) => {
    // Permite voltar para qualquer step anterior
    if (step < currentStep) {
      setCurrentStep(step);
    }
  };

  // Função para formatar valor monetário
  const formatCurrency = (value: number | null | undefined) => {
    if (value === null || value === undefined) return "—";
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  };

  // Função para formatar qualidade
  const formatQuality = (value: string | null | undefined) => {
    if (!value) return "—";
    const option = qualityOptions.find((opt) => opt.value === value);
    return option?.label || value;
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Novo Produto
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[650px]">
        <DialogHeader>
          <DialogTitle>Criar Novo Produto</DialogTitle>
          <DialogDescription>
            Preencha os dados do produto em {TOTAL_STEPS} etapas simples.
          </DialogDescription>
        </DialogHeader>

        {/* Progress Bar */}
        <div className="space-y-4">
          <Progress value={progressPercentage} className="h-2" />

          {/* Step Indicators */}
          <div className="flex justify-between">
            {STEPS.map((step) => {
              const Icon = step.icon;
              const isActive = step.id === currentStep;
              const isCompleted = step.id < currentStep;
              const isClickable = step.id < currentStep;

              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => goToStep(step.id)}
                  disabled={!isClickable}
                  className={`flex flex-col items-center gap-1 transition-colors ${
                    isClickable ? "cursor-pointer" : "cursor-default"
                  }`}
                >
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all ${
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
                      <Icon className="h-5 w-5" />
                    )}
                  </div>
                  <span
                    className={`text-xs font-medium ${
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
        </div>

        <Separator />

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Step 1: Identificação */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="sku">SKU (automático)</Label>
                  <Input
                    id="sku"
                    placeholder={isLoadingSku ? "Carregando..." : "PROD-001"}
                    {...register("sku")}
                    readOnly
                    disabled={isLoadingSku}
                    className="bg-muted"
                  />
                  <p className="text-xs text-muted-foreground">
                    Gerado automaticamente
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="partNumber">Part Number</Label>
                  <Input
                    id="partNumber"
                    placeholder="OEM / Código original"
                    {...register("partNumber")}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Nome do Produto *</Label>
                <Input
                  id="name"
                  placeholder="Nome do produto"
                  {...register("name")}
                  aria-invalid={!!errors.name}
                />
                {errors.name && (
                  <p className="text-sm text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">
                  Descrição (gerada automaticamente)
                </Label>
                <Textarea
                  id="description"
                  placeholder="Preencha o nome e part number para gerar automaticamente"
                  {...register("description")}
                  className="min-h-24 resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  Gerada a partir do nome e part number. Você pode editar.
                </p>
                {errors.description && (
                  <p className="text-sm text-destructive">
                    {errors.description.message}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Preços e Estoque */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="costPrice">Preço de Custo</Label>
                  <Controller
                    name="costPrice"
                    control={control}
                    render={({ field }) => (
                      <CurrencyInput
                        id="costPrice"
                        placeholder="0,00"
                        value={field.value}
                        onChange={field.onChange}
                      />
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="markup">Margem (%) - automática</Label>
                  <Controller
                    name="markup"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="markup"
                        value={
                          field.value !== null && field.value !== undefined
                            ? `${field.value.toFixed(2)}%`
                            : ""
                        }
                        placeholder="Informe custo e venda"
                        readOnly
                        className="bg-muted"
                      />
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    (Venda - Custo) / Custo × 100
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="price">Preço de Venda *</Label>
                  <Controller
                    name="price"
                    control={control}
                    render={({ field }) => (
                      <CurrencyInput
                        id="price"
                        placeholder="0,00"
                        value={field.value}
                        onChange={(v) => field.onChange(v ?? 0)}
                        aria-invalid={!!errors.price}
                      />
                    )}
                  />
                  {errors.price && (
                    <p className="text-sm text-destructive">
                      {errors.price.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stock">Quantidade em Estoque *</Label>
                  <Input
                    id="stock"
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    {...register("stock", { valueAsNumber: true })}
                    aria-invalid={!!errors.stock}
                    onChange={(e) => {
                      const value = parseInt(e.target.value);
                      setValue("stock", isNaN(value) ? 0 : value);
                    }}
                  />
                  {errors.stock && (
                    <p className="text-sm text-destructive">
                      {errors.stock.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="location">Localização no Estoque</Label>
                <Input
                  id="location"
                  placeholder="Ex: Prateleira A1, Gaveta 3"
                  {...register("location")}
                />
                <p className="text-xs text-muted-foreground">
                  Onde o produto está armazenado fisicamente
                </p>
              </div>
            </div>
          )}

          {/* Step 3: Veículo e Peça */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quality">Qualidade</Label>
                  <Controller
                    name="quality"
                    control={control}
                    render={({ field }) => (
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || undefined}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {qualityOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="brand">Marca</Label>
                  <Input
                    id="brand"
                    placeholder="Ex: Bosch, Denso"
                    {...register("brand")}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="model">Modelo</Label>
                  <Input
                    id="model"
                    placeholder="Ex: Civic"
                    {...register("model")}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="year">Ano</Label>
                  <Input
                    id="year"
                    placeholder="Ex: 2018-2022"
                    {...register("year")}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="version">Versão</Label>
                  <Input
                    id="version"
                    placeholder="Ex: EXL, LX"
                    {...register("version")}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="category">
                  Categoria (sugerida automaticamente)
                </Label>
                <Controller
                  name="category"
                  control={control}
                  render={({ field }) => (
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || undefined}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione uma categoria..." />
                      </SelectTrigger>
                      <SelectContent>
                        {ML_CATEGORIES.map((cat) => (
                          <SelectItem key={cat.id} value={cat.value}>
                            {cat.value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  Sugerida com base no nome. Categorias do Mercado Livre.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sourceVehicle">Veículo de Origem</Label>
                <Input
                  id="sourceVehicle"
                  placeholder="Ex: Honda Civic 2020 - Placa ABC1234"
                  {...register("sourceVehicle")}
                />
                <p className="text-xs text-muted-foreground">
                  Para peças de sucata, informe o veículo de origem
                </p>
              </div>

              <Separator />

              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-2">
                  <Controller
                    name="isSecurityItem"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="isSecurityItem"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label htmlFor="isSecurityItem" className="cursor-pointer">
                    Item de Segurança
                  </Label>
                </div>

                <div className="flex items-center gap-2">
                  <Controller
                    name="isTraceable"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="isTraceable"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label htmlFor="isTraceable" className="cursor-pointer">
                    Item Rastreável
                  </Label>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Revisão */}
          {currentStep === 4 && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Identificação</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">SKU:</span>{" "}
                    <span className="font-medium">{formValues.sku || "—"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Part Number:</span>{" "}
                    <span className="font-medium">
                      {formValues.partNumber || "—"}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Nome:</span>{" "}
                    <span className="font-medium">
                      {formValues.name || "—"}
                    </span>
                  </div>
                  {formValues.description && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Descrição:</span>{" "}
                      <span className="font-medium">
                        {formValues.description}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Preços e Estoque</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Preço Custo:</span>{" "}
                    <span className="font-medium">
                      {formatCurrency(formValues.costPrice)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Margem:</span>{" "}
                    <span className="font-medium">
                      {formValues.markup ? `${formValues.markup}%` : "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Preço Venda:</span>{" "}
                    <span className="font-medium text-primary">
                      {formatCurrency(formValues.price)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Estoque:</span>{" "}
                    <span className="font-medium">
                      {formValues.stock} unidades
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Localização:</span>{" "}
                    <span className="font-medium">
                      {formValues.location || "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Veículo e Peça</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Qualidade:</span>{" "}
                    <span className="font-medium">
                      {formatQuality(formValues.quality)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Marca:</span>{" "}
                    <span className="font-medium">
                      {formValues.brand || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Modelo:</span>{" "}
                    <span className="font-medium">
                      {formValues.model || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Ano:</span>{" "}
                    <span className="font-medium">
                      {formValues.year || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Versão:</span>{" "}
                    <span className="font-medium">
                      {formValues.version || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Categoria:</span>{" "}
                    <span className="font-medium">
                      {formValues.category || "—"}
                    </span>
                  </div>
                  {formValues.sourceVehicle && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">
                        Veículo Origem:
                      </span>{" "}
                      <span className="font-medium">
                        {formValues.sourceVehicle}
                      </span>
                    </div>
                  )}
                  <div className="col-span-2 flex gap-4 pt-2">
                    {formValues.isSecurityItem && (
                      <span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                        Item de Segurança
                      </span>
                    )}
                    {formValues.isTraceable && (
                      <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        Rastreável
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Footer com navegação */}
          <div className="flex items-center justify-between pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={
                currentStep === 1 ? () => handleOpenChange(false) : handleBack
              }
              disabled={isSubmitting}
            >
              {currentStep === 1 ? (
                "Cancelar"
              ) : (
                <>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Voltar
                </>
              )}
            </Button>

            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Etapa {currentStep} de {TOTAL_STEPS}
              </span>

              {currentStep < TOTAL_STEPS ? (
                <Button type="button" onClick={handleNext}>
                  Próximo
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              ) : (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Criando...
                    </>
                  ) : (
                    <>
                      <Check className="mr-1 h-4 w-4" />
                      Criar Produto
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
