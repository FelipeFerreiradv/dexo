"use client";

import { useState, useEffect, useRef } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImageUpload } from "@/components/ui/image-upload";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

// NextAuth
import { useSession } from "next-auth/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CurrencyInput } from "@/components/ui/currency-input";

// Categorias do Mercado Livre para Autopeças
const ML_CATEGORIES = [
  {
    id: "MLB1747",
    value: "Acessórios para Veículos",
    keywords: ["acessório", "acessorios", "tapete", "capa", "volante", "pedal"],
  },
  {
    id: "MLB1748",
    value: "Motor e Peças",
    keywords: [
      "motor",
      "biela",
      "pistão",
      "piston",
      "virabrequim",
      "cabeçote",
      "valvula",
      "válvula",
      "junta",
      "bloco",
      "cárter",
      "carter",
      "bronzina",
      "anéis",
      "aneis",
    ],
  },
  {
    id: "MLB1749",
    value: "Peças Automotivas",
    keywords: ["peça", "peças", "reposição", "automotiva"],
  },
  {
    id: "MLB1750",
    value: "Suspensão",
    keywords: [
      "suspensão",
      "amortecedor",
      "mola",
      "pivô",
      "pivo",
      "bandeja",
      "bieleta",
      "batente",
      "coifa",
      "terminal",
      "bucha",
      "buchas",
    ],
  },
  {
    id: "MLB1751",
    value: "Freios",
    keywords: [
      "freio",
      "disco",
      "pastilha",
      "lonas",
      "tambor",
      "pinça",
      "pinca",
      "cilindro",
      "flexível",
      "flexivel",
      "abs",
    ],
  },
  {
    id: "MLB1752",
    value: "Direção",
    keywords: [
      "direção",
      "direcao",
      "caixa de direção",
      "bomba direção",
      "terminal",
      "barra",
      "axial",
      "hidráulico",
      "hidraulico",
    ],
  },
  {
    id: "MLB1753",
    value: "Elétrica",
    keywords: [
      "elétrica",
      "eletrica",
      "alternador",
      "motor de arranque",
      "partida",
      "bobina",
      "vela",
      "cabo",
      "chicote",
      "sensor",
      "módulo",
      "modulo",
      "central",
      "ecu",
      "fusível",
      "fusivel",
      "relé",
      "rele",
    ],
  },
  {
    id: "MLB1754",
    value: "Transmissão",
    keywords: [
      "transmissão",
      "transmissao",
      "câmbio",
      "cambio",
      "embreagem",
      "platô",
      "plato",
      "disco",
      "atuador",
      "diferencial",
      "junta homocinética",
      "homocinética",
      "homocinetica",
      "cardã",
      "cardan",
      "semieixo",
      "trambulador",
      "sincronizador",
    ],
  },
  {
    id: "MLB1755",
    value: "Arrefecimento",
    keywords: [
      "arrefecimento",
      "radiador",
      "ventoinha",
      "bomba d'água",
      "bomba dagua",
      "válvula termostática",
      "termostatica",
      "mangueira",
      "reservatório",
      "reservatorio",
    ],
  },
  {
    id: "MLB1756",
    value: "Escapamento",
    keywords: [
      "escapamento",
      "catalisador",
      "silencioso",
      "coletor",
      "downpipe",
      "ponteira",
      "abraçadeira",
      "abracadeira",
      "flexível",
      "flexivel",
    ],
  },
  {
    id: "MLB1757",
    value: "Injeção Eletrônica",
    keywords: [
      "injeção",
      "injecao",
      "bico",
      "corpo de borboleta",
      "tbi",
      "maf",
      "sensor",
      "sonda",
      "lambda",
      "regulador",
      "pressão combustível",
      "bomba combustível",
    ],
  },
  {
    id: "MLB1758",
    value: "Iluminação",
    keywords: [
      "farol",
      "lanterna",
      "pisca",
      "luz",
      "lâmpada",
      "lampada",
      "xenon",
      "led",
      "milha",
      "neblina",
      "refletor",
    ],
  },
  {
    id: "MLB1759",
    value: "Carroceria e Estrutura",
    keywords: [
      "carroceria",
      "paralama",
      "parachoque",
      "porta",
      "capô",
      "capo",
      "tampa",
      "longarina",
      "coluna",
      "assoalho",
      "teto",
    ],
  },
  {
    id: "MLB1760",
    value: "Vidros",
    keywords: [
      "vidro",
      "parabrisa",
      "para-brisa",
      "vigia",
      "lateral",
      "retrovisor",
    ],
  },
  {
    id: "MLB1761",
    value: "Interior",
    keywords: [
      "painel",
      "console",
      "banco",
      "forro",
      "carpete",
      "acabamento",
      "maçaneta",
      "macaneta",
      "interruptor",
    ],
  },
  {
    id: "MLB1762",
    value: "Ar Condicionado",
    keywords: [
      "ar condicionado",
      "compressor",
      "condensador",
      "evaporador",
      "filtro cabine",
      "gás",
      "gas",
    ],
  },
  {
    id: "MLB1763",
    value: "Filtros",
    keywords: [
      "filtro",
      "óleo",
      "oleo",
      "ar",
      "combustível",
      "combustivel",
      "cabine",
      "polen",
    ],
  },
  {
    id: "MLB1764",
    value: "Pneus e Rodas",
    keywords: ["pneu", "roda", "aro", "calota", "parafuso", "porca"],
  },
];

// Função para sugerir categoria baseada no título
function suggestCategory(title: string): string | null {
  const lowerTitle = title.toLowerCase();

  for (const category of ML_CATEGORIES) {
    for (const keyword of category.keywords) {
      if (lowerTitle.includes(keyword.toLowerCase())) {
        return category.value;
      }
    }
  }

  return null;
}

// Schema de validação com campos de autopeças
const productEditSchema = z.object({
  name: z
    .string()
    .min(3, "Nome deve ter pelo menos 3 caracteres")
    .max(100, "Nome deve ter no máximo 100 caracteres"),
  description: z
    .string()
    .max(500, "Descrição deve ter no máximo 500 caracteres")
    .optional(),
  price: z
    .number({ invalid_type_error: "Preço deve ser um número" })
    .min(0, "Preço deve ser maior ou igual a zero")
    .multipleOf(0.01, "Preço deve ter no máximo 2 casas decimais"),
  stock: z
    .number({ invalid_type_error: "Estoque deve ser um número" })
    .int("Estoque deve ser um número inteiro")
    .min(0, "Estoque deve ser maior ou igual a zero"),

  // Campos de autopeças (opcionais)
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
  brand: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  year: z.string().max(20).optional().nullable(),
  version: z.string().max(100).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  partNumber: z.string().max(100).optional().nullable(),
  quality: z
    .enum(["SUCATA", "SEMINOVO", "NOVO", "RECONDICIONADO"])
    .optional()
    .nullable(),
  isSecurityItem: z.boolean().optional(),
  isTraceable: z.boolean().optional(),
  sourceVehicle: z.string().max(200).optional().nullable(),
  imageUrl: z.string().url("URL da imagem inválida").optional().nullable(),
});

type ProductEditFormData = z.infer<typeof productEditSchema>;

type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";

interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  price: number;
  stock: number;
  createdAt: string;
  updatedAt: string;
  // Campos de autopeças
  costPrice?: number | null;
  markup?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  category?: string | null;
  location?: string | null;
  partNumber?: string | null;
  quality?: Quality | null;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string | null;
  imageUrl?: string | null;
}

interface EditProductDialogProps {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProductUpdated: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

const qualityOptions = [
  { value: "SUCATA", label: "Sucata" },
  { value: "SEMINOVO", label: "Seminovo" },
  { value: "NOVO", label: "Novo" },
  { value: "RECONDICIONADO", label: "Recondicionado" },
];

export function EditProductDialog({
  product,
  open,
  onOpenChange,
  onProductUpdated,
  onToast,
}: EditProductDialogProps) {
  const { data: session } = useSession();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAutopartsSection, setShowAutopartsSection] = useState(false);

  // Referências para valores originais do produto (para detectar edições do usuário)
  const originalNameRef = useRef(product.name);
  const originalPartNumberRef = useRef(product.partNumber || "");

  // Verificar se há campos de autopeças preenchidos
  const hasAutopartsData = !!(
    product.brand ||
    product.model ||
    product.year ||
    product.quality ||
    product.category ||
    product.sourceVehicle
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    reset,
    control,
    watch,
  } = useForm<ProductEditFormData>({
    resolver: zodResolver(productEditSchema),
    defaultValues: {
      name: product.name,
      description: product.description || "",
      price: product.price,
      stock: product.stock,
      costPrice: product.costPrice || null,
      markup: product.markup || null,
      brand: product.brand || "",
      model: product.model || "",
      year: product.year || "",
      version: product.version || "",
      category: product.category || "",
      location: product.location || "",
      partNumber: product.partNumber || "",
      quality: product.quality || null,
      isSecurityItem: product.isSecurityItem || false,
      isTraceable: product.isTraceable || false,
      sourceVehicle: product.sourceVehicle || "",
      imageUrl: product.imageUrl || null,
    },
  });

  // Watch para campos automáticos
  const watchName = watch("name");
  const watchPartNumber = watch("partNumber");
  const watchCostPrice = watch("costPrice");
  const watchPrice = watch("price");

  useEffect(() => {
    if (open) {
      // Atualizar refs com valores originais do produto
      originalNameRef.current = product.name;
      originalPartNumberRef.current = product.partNumber || "";

      reset({
        name: product.name,
        description: product.description || "",
        price: product.price,
        stock: product.stock,
        costPrice: product.costPrice || null,
        markup: product.markup || null,
        brand: product.brand || "",
        model: product.model || "",
        year: product.year || "",
        version: product.version || "",
        category: product.category || "",
        location: product.location || "",
        partNumber: product.partNumber || "",
        quality: product.quality || null,
        isSecurityItem: product.isSecurityItem || false,
        isTraceable: product.isTraceable || false,
        sourceVehicle: product.sourceVehicle || "",
      });
      // Abrir seção de autopeças se houver dados
      setShowAutopartsSection(hasAutopartsData);
    }
  }, [open, product, reset, hasAutopartsData]);

  // Auto descrição - só atualiza se o usuário editou o nome ou partNumber
  useEffect(() => {
    const nameChanged = watchName !== originalNameRef.current;
    const partNumberChanged = watchPartNumber !== originalPartNumberRef.current;

    if (watchName && (nameChanged || partNumberChanged)) {
      let autoDescription = watchName;
      if (watchPartNumber) {
        autoDescription += `\nPart Number: ${watchPartNumber}`;
      }
      setValue("description", autoDescription);
    }
  }, [watchName, watchPartNumber, setValue]);

  // Cálculo automático da margem
  useEffect(() => {
    if (watchCostPrice && watchPrice && watchCostPrice > 0) {
      const markup = ((watchPrice - watchCostPrice) / watchCostPrice) * 100;
      setValue("markup", Math.round(markup * 100) / 100);
    }
  }, [watchCostPrice, watchPrice, setValue]);

  // Sugestão automática de categoria - só atualiza se o usuário editou o nome
  useEffect(() => {
    const nameChanged = watchName !== originalNameRef.current;

    if (watchName && nameChanged) {
      const suggested = suggestCategory(watchName);
      if (suggested) {
        setValue("category", suggested);
      }
    }
  }, [watchName, setValue]);

  const onSubmit = async (data: ProductEditFormData) => {
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
        imageUrl: data.imageUrl || undefined,
      };

      const response = await fetch(
        `http://localhost:3333/products/${product.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            email: session?.user?.email || "",
          },
          body: JSON.stringify(cleanData),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Erro ao atualizar produto");
      }

      onToast("Produto atualizado com sucesso!", "success");
      onOpenChange(false);
      onProductUpdated();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Erro ao atualizar produto",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Editar Produto</DialogTitle>
          <DialogDescription>
            Atualize os dados do produto &quot;{product.name}&quot;
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Seção: Dados Básicos */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">
              Dados Básicos
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-sku">SKU</Label>
                <Input
                  id="edit-sku"
                  value={product.sku}
                  disabled
                  className="bg-muted"
                />
                <p className="text-xs text-muted-foreground">
                  SKU não pode ser alterado
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-partNumber">Part Number</Label>
                <Input
                  id="edit-partNumber"
                  placeholder="OEM / Código original"
                  {...register("partNumber")}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-name">Nome *</Label>
              <Input
                id="edit-name"
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
              <Label htmlFor="edit-description">Descrição (automática)</Label>
              <Textarea
                id="edit-description"
                placeholder="Descrição do produto"
                {...register("description")}
                className="min-h-20 resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Atualizada ao editar nome ou part number
              </p>
              {errors.description && (
                <p className="text-sm text-destructive">
                  {errors.description.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Foto do Produto</Label>
              <Controller
                name="imageUrl"
                control={control}
                render={({ field }) => (
                  <ImageUpload
                    value={field.value || undefined}
                    onChange={field.onChange}
                    onError={(error: string) => {
                      console.error("Erro no upload:", error);
                      // You might want to show a toast here
                    }}
                  />
                )}
              />
              {errors.imageUrl && (
                <p className="text-sm text-destructive">
                  {errors.imageUrl.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Faça upload de uma nova foto ou mantenha a atual. Máximo 5MB,
                formatos: JPG, PNG, WebP.
              </p>
            </div>
          </div>

          {/* Seção: Preços e Estoque */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">
              Preços e Estoque
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-costPrice">Preço de Custo</Label>
                <Controller
                  name="costPrice"
                  control={control}
                  render={({ field }) => (
                    <CurrencyInput
                      id="edit-costPrice"
                      placeholder="0,00"
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-price">Preço de Venda *</Label>
                <Controller
                  name="price"
                  control={control}
                  render={({ field }) => (
                    <CurrencyInput
                      id="edit-price"
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
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-markup">Margem (%) - calculada</Label>
                <Controller
                  name="markup"
                  control={control}
                  render={({ field }) => (
                    <Input
                      id="edit-markup"
                      value={
                        field.value !== null && field.value !== undefined
                          ? `${field.value.toFixed(2)}%`
                          : ""
                      }
                      placeholder="Informe custo e venda"
                      disabled
                      className="bg-muted"
                    />
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  = (Venda - Custo) / Custo × 100
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-stock">Estoque *</Label>
                <Input
                  id="edit-stock"
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
          </div>

          {/* Seção: Dados de Autopeças (Colapsável) */}
          <Collapsible
            open={showAutopartsSection}
            onOpenChange={setShowAutopartsSection}
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="flex w-full justify-between p-0 hover:bg-transparent"
              >
                <span className="text-sm font-medium text-muted-foreground">
                  Dados do Veículo e Peça
                </span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${
                    showAutopartsSection ? "rotate-180" : ""
                  }`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-quality">Qualidade</Label>
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
                  <Label htmlFor="edit-brand">Marca</Label>
                  <Input
                    id="edit-brand"
                    placeholder="Ex: Bosch, Denso"
                    {...register("brand")}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-model">Modelo</Label>
                  <Input
                    id="edit-model"
                    placeholder="Ex: Civic, Corolla"
                    {...register("model")}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-year">Ano</Label>
                  <Input
                    id="edit-year"
                    placeholder="Ex: 2018-2022"
                    {...register("year")}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-version">Versão</Label>
                  <Input
                    id="edit-version"
                    placeholder="Ex: EXL, LX"
                    {...register("version")}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-category">
                    Categoria ML (automática)
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
                    Sugerida ao editar nome
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-location">Localização</Label>
                  <Input
                    id="edit-location"
                    placeholder="Ex: Prateleira A1"
                    {...register("location")}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-sourceVehicle">Veículo de Origem</Label>
                <Input
                  id="edit-sourceVehicle"
                  placeholder="Ex: Honda Civic 2020 - Placa ABC1234"
                  {...register("sourceVehicle")}
                />
                <p className="text-xs text-muted-foreground">
                  Para peças de sucata, informe o veículo de origem
                </p>
              </div>

              <div className="flex flex-wrap gap-6 pt-2">
                <div className="flex items-center gap-2">
                  <Controller
                    name="isSecurityItem"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="edit-isSecurityItem"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label
                    htmlFor="edit-isSecurityItem"
                    className="cursor-pointer"
                  >
                    Item de Segurança
                  </Label>
                </div>

                <div className="flex items-center gap-2">
                  <Controller
                    name="isTraceable"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="edit-isTraceable"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label htmlFor="edit-isTraceable" className="cursor-pointer">
                    Item Rastreável
                  </Label>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Atualizando...
                </>
              ) : (
                "Atualizar Produto"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
