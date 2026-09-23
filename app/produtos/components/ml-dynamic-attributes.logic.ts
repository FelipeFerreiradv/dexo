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
  /**
   * Unidades aceitas em atributo `number_unit` (`allowed_units` do ML) e a
   * padrão. Ausentes (cache antigo do catálogo) = campo numérico de sempre.
   */
  allowedUnits?: string[];
  defaultUnit?: string;
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

/**
 * Código OEM: campo FIXO da ficha técnica, presente em qualquer categoria.
 *
 * Por que fixo e não um atributo dinâmico: `OEM` está em FIXED_FIELD_ATTRS
 * (acima), então `getVisibleAttributes` sempre o remove da lista dinâmica — e
 * tirá-lo de lá só o faria aparecer nas categorias que expõem o id, que é o
 * oposto do que o operador precisa. Fixo, ele aparece sempre; quem decide se o
 * valor vai para o Mercado Livre é o catálogo da categoria, no backend.
 *
 * Levantamento em 38 categorias reais de autopeça (as 10 citadas em
 * listing.usercase.ts + 28 folhas sob MLB22693): `OEM` ("Código OEM",
 * value_type `string`, value_max_length 255) existe em TODAS, e nunca é
 * required nem hidden. Fora de autopeça (Celulares, Esportes, Informática,
 * Brinquedos) ele não existe — daí a guarda por categoria no backend.
 */
export const OEM_FIELD_ATTR_ID = "OEM";

/** `value_max_length` real do atributo OEM no ML. */
export const OEM_MAX_LENGTH = 255;

/**
 * A seção deve renderizar? Antes era só `visible.length > 0`; com o campo OEM
 * ligado ela passa a existir mesmo numa categoria sem nenhum atributo extra —
 * que é justamente o caso em que o operador não tinha onde informar o OEM.
 */
export function shouldRenderSection(
  visibleCount: number,
  oemFieldEnabled: boolean,
): boolean {
  return visibleCount > 0 || oemFieldEnabled;
}

/** Contador do cabeçalho: o campo OEM é um campo da seção e conta como tal. */
export function sectionFieldCount(
  visibleCount: number,
  oemFieldEnabled: boolean,
): number {
  return visibleCount + (oemFieldEnabled ? 1 : 0);
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
 * Whitespace conta como vazio (mesmo trim do gate de buildMLAttributes no
 * backend, que trata POSITION em branco como ausente).
 */
export function positionNeedsInput(
  visibleAttrs: MLDynamicAttribute[],
  value: Record<string, MLAttributeValue>,
): boolean {
  const posAttr = visibleAttrs.find((a) => a.id === "POSITION");
  if (!posAttr) return false;
  const cur = value["POSITION"];
  const has = (s?: string) => typeof s === "string" && s.trim().length > 0;
  return !cur || (!has(cur.value_id) && !has(cur.value_name));
}

/**
 * Campo do tipo imagem (`picture_id`, ex.: QR code regulatório). A Dexo não
 * envia imagem por aqui, e qualquer texto digitado é recusado pelo ML (422
 * "invalid picture ID"). A ficha mostra o campo travado e, se já houver valor,
 * oferece apagá-lo.
 */
export function isPictureAttribute(attr: MLDynamicAttribute): boolean {
  return attr.valueType === "picture_id";
}

/** Número + seletor de unidade: só com as unidades aceitas em mãos. */
export function usesUnitSelector(attr: MLDynamicAttribute): boolean {
  return (
    attr.valueType === "number_unit" &&
    Array.isArray(attr.allowedUnits) &&
    attr.allowedUnits.length > 0
  );
}

const semAcentoMinusculo = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

/**
 * "30 cm" → { number: "30", unit: "cm" }. Unidade ausente ou fora da lista
 * aceita volta `unit: null` (e `invalidUnit` com o que estava escrito), para a
 * tela pedir a unidade em vez de fingir que ela existe.
 */
export function splitNumberUnit(
  raw: string | undefined | null,
  allowedUnits: readonly string[],
): { number: string; unit: string | null; invalidUnit?: string } {
  const texto = typeof raw === "string" ? raw.trim() : "";
  if (!texto) return { number: "", unit: null };
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(.*)$/.exec(texto);
  if (!m) return { number: "", unit: null, invalidUnit: texto };
  const numero = m[1].replace(",", ".");
  const unidade = m[2].trim();
  if (!unidade) return { number: numero, unit: null };
  const aceita = allowedUnits.find(
    (u) => semAcentoMinusculo(u) === semAcentoMinusculo(unidade),
  );
  return aceita
    ? { number: numero, unit: aceita }
    : { number: numero, unit: null, invalidUnit: unidade };
}

/** Valor gravado: "30 cm" (formato que o ML aceita). Sem número = limpar. */
export function joinNumberUnit(
  number: string,
  unit: string | null | undefined,
): string | null {
  const n = (number ?? "").trim();
  if (!n) return null;
  return unit ? `${n} ${unit}` : n;
}

/** Registro do INMETRO: o campo mais recusado nos logs (3702). */
export const INMETRO_ATTR_ID = "INMETRO_CERTIFICATION_REGISTRATION_NUMBER";
export const INMETRO_HINT =
  "Só o número do registro/certificação do INMETRO (vem na etiqueta ou no certificado da peça). Deixe vazio se a peça não tiver: nome da peça, \"0\" ou \"1111\" são recusados pelo Mercado Livre.";
