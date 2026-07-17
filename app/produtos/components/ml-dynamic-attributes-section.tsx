"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

import {
  getVisibleAttributes,
  isListAttribute,
  positionNeedsInput,
  type MLAttributeValue,
  type MLDynamicAttribute,
} from "./ml-dynamic-attributes.logic";

export type { MLAttributeValue, MLDynamicAttribute };

interface MLDynamicAttributesSectionProps {
  categoryId: string | null | undefined;
  value: Record<string, MLAttributeValue>;
  onChange: (next: Record<string, MLAttributeValue>) => void;
  disabled?: boolean;
  /** Override do email para o middleware. Se ausente, mantém o cookie de sessão. */
  email?: string;
}

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
  // Categoria DONA dos attrs carregados: durante a troca de categoria, `attrs`
  // ainda são da anterior até o fetch resolver — o auto-expand só pode decidir
  // com attrs da categoria ATUAL (senão abre a ficha espuriamente e consome a
  // marca "uma vez por categoria" da nova antes dos dados dela chegarem).
  const [attrsCategory, setAttrsCategory] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ficha técnica começa RECOLHIDA: só abre quando o usuário clica no cabeçalho.
  const [fichaOpen, setFichaOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = (categoryId || "").trim();
    if (!id) {
      setAttrs([]);
      setAttrsCategory("");
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
        if (!cancelled) {
          setAttrs(list as MLDynamicAttribute[]);
          setAttrsCategory(id);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAttrs([]);
          setAttrsCategory("");
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

  const visible = useMemo(() => getVisibleAttributes(attrs), [attrs]);

  // Descoberta do lado/posição: quando a categoria expõe POSITION e o operador
  // ainda não informou, destacamos e auto-abrimos a ficha (uma vez por
  // categoria) para o campo não passar despercebido na seção recolhida.
  const needsPosition = useMemo(
    () => positionNeedsInput(visible, value),
    [visible, value],
  );
  const autoExpandedFor = useRef<string | null>(null);
  useEffect(() => {
    const id = (categoryId || "").trim();
    // attrsCategory !== id ⇒ os attrs em memória são de OUTRA categoria
    // (fetch em voo) — não decidir com dado stale.
    if (!id || attrsCategory !== id || autoExpandedFor.current === id) return;
    if (needsPosition) {
      setFichaOpen(true);
      autoExpandedFor.current = id;
    }
  }, [categoryId, attrsCategory, needsPosition]);

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
            {needsPosition && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                Informe o lado/posição
              </span>
            )}
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
            const isList = isListAttribute(attr);

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
