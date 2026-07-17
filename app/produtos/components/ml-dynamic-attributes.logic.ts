/**
 * Lógica pura (sem React/UI) da ficha técnica secundária do Mercado Livre.
 * Extraída para permitir teste unitário em ambiente node — o componente
 * carrega os atributos via fetch/useEffect, que o SSR não executa.
 */

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
  /** Sinal do próprio ML (tags.hidden) de que o atributo não deve ser exibido. */
  hidden?: boolean;
};

/**
 * Atributos cobertos por outros campos do formulário (Marca, Modelo, Ano,
 * Part Number, SKU, dimensões/peso, condição). Não devem ser duplicados na
 * seção de ficha técnica para evitar input conflitante e regressões.
 *
 * NÃO adicionar "POSITION" aqui: o lado/posição da peça (ex.: farol dianteiro
 * esquerdo) precisa ser capturável pelo operador. É renderizado como o atributo
 * oficial da categoria (Select alimentado por allowedValues), gravado em
 * product.attributes.POSITION e enviado ao ML por buildMLAttributes.
 */
export const FIXED_FIELD_ATTRS = new Set([
  "BRAND",
  "MODEL",
  "YEAR",
  "VEHICLE_YEAR",
  "PART_NUMBER",
  "MPN",
  "OEM",
  "SELLER_SKU",
  "ITEM_CONDITION",
  "SELLER_PACKAGE_HEIGHT",
  "SELLER_PACKAGE_WIDTH",
  "SELLER_PACKAGE_LENGTH",
  "SELLER_PACKAGE_WEIGHT",
]);

/**
 * Atributos exibidos na ficha técnica: os que não têm campo fixo dedicado e
 * que o ML não marcou como `hidden`. NUNCA esconde um obrigatório — required
 * (required/catalog_required/fixed) sempre vence `hidden`, para não quebrar a
 * publicação. Nenhuma blocklist de domínio agressiva: a categoria correta
 * (restrição de nicho) é a alavanca; aqui só respeitamos o sinal do próprio ML.
 */
export function getVisibleAttributes(
  attrs: MLDynamicAttribute[],
): MLDynamicAttribute[] {
  return attrs.filter(
    (a) => !FIXED_FIELD_ATTRS.has(a.id) && !(a.hidden && !a.required),
  );
}

/** Renderiza como Select (lista) quando a categoria expõe valores permitidos. */
export function isListAttribute(attr: MLDynamicAttribute): boolean {
  return (
    (attr.valueType === "list" ||
      attr.valueType === "boolean" ||
      !!attr.allowedValues) &&
    Array.isArray(attr.allowedValues) &&
    attr.allowedValues.length > 0
  );
}

/**
 * True quando a categoria expõe POSITION (lado/posição) e o operador ainda
 * não informou — usado para destacar/auto-abrir a ficha técnica recolhida.
 */
export function positionNeedsInput(
  visibleAttrs: MLDynamicAttribute[],
  value: Record<string, MLAttributeValue>,
): boolean {
  const posAttr = visibleAttrs.find((a) => a.id === "POSITION");
  if (!posAttr) return false;
  const cur = value["POSITION"];
  return !cur || (!cur.value_id && !cur.value_name);
}
