"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const productSchema = z.object({
  sku: z
    .string()
    .min(1, "SKU é obrigatório")
    .max(50, "SKU deve ter no máximo 50 caracteres")
    .regex(/^[A-Za-z0-9-_]+$/, "SKU deve conter apenas letras, números, - ou _"),
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
});

type ProductFormData = z.infer<typeof productSchema>;

interface CreateProductDialogProps {
  onProductCreated: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

export function CreateProductDialog({
  onProductCreated,
  onToast,
}: CreateProductDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
    setValue,
  } = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      sku: "",
      name: "",
      description: "",
      price: 0,
      stock: 0,
    },
  });

  const onSubmit = async (data: ProductFormData) => {
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Erro ao criar produto");
      }

      onToast("Produto criado com sucesso!", "success");
      reset();
      setOpen(false);
      onProductCreated();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Erro ao criar produto",
        "error"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      reset();
    }
    setOpen(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Novo Produto
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Criar Novo Produto</DialogTitle>
          <DialogDescription>
            Preencha os dados do produto para adicionar ao catálogo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sku">SKU *</Label>
            <Input
              id="sku"
              placeholder="Ex: PROD-001"
              {...register("sku")}
              aria-invalid={!!errors.sku}
            />
            {errors.sku && (
              <p className="text-sm text-destructive">{errors.sku.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Nome *</Label>
            <Input
              id="name"
              placeholder="Nome do produto"
              {...register("name")}
              aria-invalid={!!errors.name}
            />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descrição</Label>
            <Textarea
              id="description"
              placeholder="Descrição do produto (opcional)"
              {...register("description")}
              className="min-h-20 resize-none"
            />
            {errors.description && (
              <p className="text-sm text-destructive">
                {errors.description.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="price">Preço (R$) *</Label>
              <Input
                id="price"
                type="number"
                step="0.01"
                min="0"
                placeholder="0,00"
                {...register("price", { valueAsNumber: true })}
                aria-invalid={!!errors.price}
                onChange={(e) => {
                  const value = parseFloat(e.target.value);
                  setValue("price", isNaN(value) ? 0 : value);
                }}
              />
              {errors.price && (
                <p className="text-sm text-destructive">
                  {errors.price.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="stock">Estoque *</Label>
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

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Criando...
                </>
              ) : (
                "Criar Produto"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
