"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { getApiBaseUrl } from "@/lib/api";

export type MLAttributeValue = {
  value_id?: string;
  value_name?: string;
};

export type MLDynamicAttribute = {
  id: string;
  name: string;
  valueType: string;
  required: boolean;
  variationRequired?: boolean;
  allowedValues?: Array<{ id: string; name: string }>;
  valueMaxLength?: number;
};

interface MLDynamicAttributesSectionProps {
  categoryId: string | null | undefined;
  value: Record<string, MLAttributeValue>;
  onChange: (next: Record<string, MLAttributeValue>) => void;
  disabled?: boolean;
  /** Override do email para o middleware. Se ausente, mantém o cookie de sessão. */
  email?: string;
}

/**
 * Atributos cobertos por outros campos do formulário (Marca, Modelo, Ano,
 * Part Number, SKU, dimensões/peso, condição). Não devem ser duplicados na
 * seção de ficha técnica para evitar input conflitante e regressões.
 */
const FIXED_FIELD_ATTRS = new Set([
  "BRAND",
  "MODEL",
  "YEAR",
  "VEHICLE_YEAR",
  "PART_NUMBER",
  "MPN",
  "OEM",
  "SELLER_SKU",
  "ITEM_CONDITION",
  "POSITION",
  "SELLER_PACKAGE_HEIGHT",
  "SELLER_PACKAGE_WIDTH",
  "SELLER_PACKAGE_LENGTH",
  "SELLER_PACKAGE_WEIGHT",
]);

/**
 * Renderiza a "ficha técnica secundária" oficial da categoria do Mercado Livre
 * (GET /categories/{id}/attributes). Mostra somente atributos que ainda não
 * são gerenciados por campos fixos do formulário. Se a categoria não tiver
 * atributos extras (ou a API falhar), renderiza nada — comportamento idêntico
 * ao fluxo legado.
 */
export function MLDynamicAttributesSection({
  categoryId,
  value,
  onChange,
  disabled,
  email,
}: MLDynamicAttributesSectionProps) {
  const [attrs, setAttrs] = useState<MLDynamicAttribute[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ficha técnica começa RECOLHIDA: só abre quando o usuário clica no cabeçalho.
  const [fichaOpen, setFichaOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = (categoryId || "").trim();
    if (!id) {
      setAttrs([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const headers: HeadersInit = email ? { email } : {};
    fetch(
      `${getApiBaseUrl()}/marketplace/ml/categories/${encodeURIComponent(id)}/attributes`,
      { headers, credentials: "include" },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const list = Array.isArray(data?.attributes) ? data.attributes : [];
        if (!cancelled) setAttrs(list as MLDynamicAttribute[]);
      })
      .catch((err) => {
        if (!cancelled) {
          setAttrs([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [categoryId, email]);

  const visible = useMemo(
    () => attrs.filter((a) => !FIXED_FIELD_ATTRS.has(a.id)),
    [attrs],
  );

  if (!categoryId) return null;
  if (loading) {
    return (
      <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Carregando ficha técnica da categoria...
      </div>
    );
  }
  if (error && visible.length === 0) {
    // Falha + nada a mostrar = silencioso, sem regressão visual.
    return null;
  }
  if (visible.length === 0) return null;

  const updateAttr = (id: string, next: MLAttributeValue | null) => {
    const copy = { ...value };
    if (!next || (!next.value_id && !next.value_name)) {
      delete copy[id];
    } else {
      copy[id] = next;
    }
    onChange(copy);
  };

  return (
    <Collapsible
      open={fichaOpen}
      onOpenChange={setFichaOpen}
      className="mt-4 rounded-md border border-dashed p-4"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left">
        <div>
          <div className="text-sm font-medium">
            Ficha técnica (Mercado Livre){" "}
            <span className="font-normal text-muted-foreground">
              · {visible.length} campos
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Campos oficiais desta categoria. Os obrigatórios são marcados com{" "}
            <span className="text-red-600">*</span>.
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${fichaOpen ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {visible.map((attr) => {
            const current = value[attr.id] || {};
            const isList =
              (attr.valueType === "list" ||
                attr.valueType === "boolean" ||
                !!attr.allowedValues) &&
              Array.isArray(attr.allowedValues) &&
              attr.allowedValues.length > 0;

            if (isList) {
              return (
                <div key={attr.id} className="space-y-1">
                  <Label htmlFor={`ml-attr-${attr.id}`}>
                    {attr.name}
                    {attr.required && (
                      <span className="ml-0.5 text-red-600">*</span>
                    )}
                  </Label>
                  <Select
                    value={current.value_id || ""}
                    onValueChange={(v) => {
                      if (!v) {
                        updateAttr(attr.id, null);
                        return;
                      }
                      const opt = attr.allowedValues?.find((o) => o.id === v);
                      updateAttr(attr.id, {
                        value_id: v,
                        value_name: opt?.name,
                      });
                    }}
                    disabled={disabled}
                  >
                    <SelectTrigger id={`ml-attr-${attr.id}`}>
                      <SelectValue
                        placeholder={`Selecione ${attr.name.toLowerCase()}`}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {attr.allowedValues?.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            }

            const inputType =
              attr.valueType === "number" || attr.valueType === "number_unit"
                ? "number"
                : "text";
            return (
              <div key={attr.id} className="space-y-1">
                <Label htmlFor={`ml-attr-${attr.id}`}>
                  {attr.name}
                  {attr.required && (
                    <span className="ml-0.5 text-red-600">*</span>
                  )}
                </Label>
                <Input
                  id={`ml-attr-${attr.id}`}
                  type={inputType}
                  value={current.value_name ?? ""}
                  onChange={(e) => {
                    const text = e.target.value;
                    if (!text || !text.trim()) {
                      updateAttr(attr.id, null);
                      return;
                    }
                    updateAttr(attr.id, { value_name: text });
                  }}
                  maxLength={attr.valueMaxLength}
                  disabled={disabled}
                  placeholder={attr.required ? "Obrigatório" : "Opcional"}
                />
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default MLDynamicAttributesSection;
