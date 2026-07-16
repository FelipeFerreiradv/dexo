/**
 * Tradução do `cause[]` do Mercado Livre para uma mensagem acionável.
 *
 * Por que existe: o ML valida o CORPO do item antes dos ATRIBUTOS. Um produto
 * em categoria de catálogo (User Product) sem `partNumber` cadastrado falha
 * assim:
 *
 *   1ª tentativa  → `body.required_fields [family_name]` (369)
 *   retentativa com family_name → `item.attributes.missing_required [PART_NUMBER]` (147)
 *   categoria sugerida          → idem
 *   escada esgota → re-lança o erro ORIGINAL = family_name
 *
 * O operador via "family_name" e não tinha como saber que o problema real era
 * o Número da Peça em branco. Estas funções escolhem, entre a tentativa
 * original e as retentativas, a causa que o operador consegue resolver.
 *
 * Conservador por construção: sem uma causa reconhecida, devolve null e o
 * caller mantém a mensagem atual.
 */

export interface MLCause {
  code?: string;
  message?: string;
  department?: string;
  cause_id?: number;
  type?: string;
}

/** Rótulos em português dos atributos que já vimos o ML exigir. */
const ATTR_LABELS: Record<string, string> = {
  PART_NUMBER: "Número da Peça",
  MPN: "Número da Peça (MPN)",
  OEM: "Número da Peça (OEM)",
  BRAND: "Marca",
  MODEL: "Modelo",
  YEAR: "Ano",
  COLOR: "Cor",
};

const labelFor = (attrId: string) => ATTR_LABELS[attrId] || attrId;

/** `The attributes [PART_NUMBER] are required for category MLB7863...` */
const MISSING_ATTRS_RE = /attributes?\s*\[([^\]]+)\]/i;
/** `...required for category MLB7863 and channel marketplace` */
const CATEGORY_RE = /category\s+(ML[A-Z]?\d+)/i;

const parseMissingAttributes = (message: string): string[] => {
  const match = MISSING_ATTRS_RE.exec(message);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const isMissingRequiredAttrs = (cause: MLCause) =>
  cause?.code === "item.attributes.missing_required" ||
  cause?.cause_id === 147;

/**
 * Monta a mensagem acionável a partir de uma causa de atributo obrigatório.
 * Retorna null se a causa não for reconhecida ou não citar atributo.
 */
export function describeMissingAttributesCause(
  cause: MLCause,
  fallbackCategoryId?: string,
): string | null {
  if (!isMissingRequiredAttrs(cause)) return null;

  const message = String(cause.message || "");
  const attrs = parseMissingAttributes(message);
  if (attrs.length === 0) return null;

  const categoryId = CATEGORY_RE.exec(message)?.[1] || fallbackCategoryId;
  const labels = attrs.map(labelFor).join(", ");
  const categoryPart = categoryId ? `A categoria ${categoryId}` : "A categoria";

  return (
    `${categoryPart} do Mercado Livre exige ${attrs.length > 1 ? "os campos" : "o campo"} ` +
    `${labels}. Preencha ${attrs.length > 1 ? "esses campos" : "esse campo"} no cadastro do produto e recrie o anúncio.`
  );
}

/**
 * Escolhe a mensagem mais acionável entre todas as tentativas de criação.
 *
 * `attempts` deve vir em ordem cronológica (original primeiro, retentativas
 * depois). Como a escada só chega em `missing_required` DEPOIS de resolver o
 * `family_name`, a causa mais tardia costuma ser a mais informativa — por isso
 * varremos de trás para frente.
 *
 * @returns mensagem para o operador, ou null para manter a mensagem atual.
 */
export function pickActionableMLError(
  attempts: MLCause[][],
  fallbackCategoryId?: string,
): string | null {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const causes = attempts[i];
    if (!Array.isArray(causes)) continue;
    for (const cause of causes) {
      const described = describeMissingAttributesCause(
        cause,
        fallbackCategoryId,
      );
      if (described) return described;
    }
  }
  return null;
}
