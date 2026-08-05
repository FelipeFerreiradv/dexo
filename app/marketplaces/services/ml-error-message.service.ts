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

/* -------------------------------------------------------------------------
 * Causas medidas em produção — 05/08/2026.
 *
 * Amostra de 14 anúncios parados com `lastError` de `family_name`, revalidados
 * um a um contra `POST /items/validate` com o corpo que a escada JÁ envia na
 * retentativa (com `family_name`, sem `title`). NENHUM deles estava de fato
 * barrado por `family_name` — a escada resolve isso sozinha desde sempre. As
 * causas reais, todas corrigíveis pelo operador e nenhuma visível para ele:
 *
 *   6x  7711  GTIN em formato inválido (o part number foi digitado no campo
 *             de código de barras)
 *   3x  5400  medidas do pacote em branco
 *   2x  4053  conta sem o modo de envio exigido pela categoria
 *   2x  3510  valor de atributo recusado pela categoria
 *
 * É por isso que 136 anúncios ficaram meses parados: o `lastError` guardava o
 * erro da PRIMEIRA tentativa, e nenhuma destas causas era reconhecida aqui —
 * caíam no `null` e a mensagem enganosa permanecia.
 * ------------------------------------------------------------------------- */

/** `Product Identifier [GTIN] contains values with invalid format: [754243m6a]` */
const IDENTIFIER_RE =
  /identifier\s*\[([^\]]+)\][^[]*\[([^\]]+)\]/i;
/** `Attribute [VEHICLE_TYPE] is not valid, item values [(13222040:Linha Pesada)]` */
const INVALID_VALUE_RE = /attribute\s*\[([^\]]+)\][^[]*\[\(?[^:]*:?([^)\]]*)\)?\]/i;

const isInvalidProductIdentifier = (cause: MLCause) =>
  cause?.code === "item.attribute.product_identifier.invalid_format" ||
  cause?.cause_id === 7711;

const isMissingPackageDimensions = (cause: MLCause) =>
  cause?.code === "item.attribute.missing.seller.package.dimensions" ||
  cause?.cause_id === 5400;

const isInvalidAttributeValue = (cause: MLCause) =>
  cause?.code === "invalid.item.attribute.values" || cause?.cause_id === 3510;

/*
 * `shipping.lost_me1_by_user` (4053) NÃO entra na lista de propósito.
 *
 * O módulo já tratava essa causa como AVISO — o teste
 * "não confunde o warning de shipping com uma causa acionável" trava isso — e a
 * medição de 05/08 confirma a decisão em vez de contradizê-la: o 4053 apareceu
 * inclusive em corpos que não tinham nenhum outro problema, ou seja, ele vem de
 * carona. Traduzi-lo mandaria o operador mexer no frete da conta quando o que
 * faltava era um campo do cadastro.
 */

/**
 * Quanto MENOR, mais merece virar a mensagem do operador.
 *
 * Existe porque o ML devolve VÁRIAS causas numa mesma resposta e a ordem não é
 * garantida — medido: `301 + 306 + 3510` e `306 + 5400` vieram misturados. Sem
 * isso a mensagem dependeria de qual causa o ML resolveu listar primeiro.
 *
 * "Campo obrigatório em branco" vem antes de "valor recusado" porque é o que o
 * operador resolve mais rápido: preencher um campo vazio é mais direto do que
 * descobrir qual valor a categoria aceita.
 */
function prioridadeDaCausa(cause: MLCause): number {
  if (isMissingRequiredAttrs(cause)) return 0;
  if (isMissingPackageDimensions(cause)) return 1;
  if (isInvalidProductIdentifier(cause) || isInvalidAttributeValue(cause)) {
    return 2;
  }
  return 99;
}

/**
 * Traduz uma causa em mensagem acionável. `null` para causa não reconhecida —
 * o contrato conservador do módulo inteiro: sem certeza, o caller mantém a
 * mensagem que já mostrava.
 */
export function describeMLCause(
  cause: MLCause,
  fallbackCategoryId?: string,
): string | null {
  const daFicha = describeMissingAttributesCause(cause, fallbackCategoryId);
  if (daFicha) return daFicha;

  const message = String(cause?.message || "");

  if (isInvalidProductIdentifier(cause)) {
    const m = IDENTIFIER_RE.exec(message);
    const campo = m?.[1] ? labelFor(m[1]) : "código de barras";
    const valor = m?.[2];
    return (
      `O campo ${campo} do produto está em formato inválido` +
      `${valor ? ` ("${valor}")` : ""}. ` +
      "Esse campo aceita apenas código de barras (EAN/UPC) — se o que você tem " +
      "é o número da peça, use o campo Número da Peça. Corrija na ficha técnica " +
      "e recrie o anúncio."
    );
  }

  if (isMissingPackageDimensions(cause)) {
    return (
      "O Mercado Livre exige as medidas do pacote nesta categoria. Preencha " +
      "altura, largura, comprimento e peso no cadastro do produto e recrie o anúncio."
    );
  }

  if (isInvalidAttributeValue(cause)) {
    const m = INVALID_VALUE_RE.exec(message);
    const attr = m?.[1] ? labelFor(m[1]) : null;
    const valor = m?.[2]?.trim();
    return (
      `O Mercado Livre não aceita ${attr ? `o valor de ${attr}` : "um dos valores da ficha técnica"}` +
      `${valor ? ` ("${valor}")` : ""} nesta categoria. ` +
      "Escolha outro valor na ficha técnica ou revise a categoria do anúncio."
    );
  }

  return null;
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
  /**
   * `somenteObrigatorios: true` restaura o comportamento anterior a 05/08/2026,
   * em que só `item.attributes.missing_required` era reconhecido. É o que o
   * kill-switch `ML_ERROR_DETAIL_DISABLED=1` aciona.
   */
  opts?: { somenteObrigatorios?: boolean },
): string | null {
  const descrever = opts?.somenteObrigatorios
    ? describeMissingAttributesCause
    : describeMLCause;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const causes = attempts[i];
    if (!Array.isArray(causes)) continue;

    // Dentro de UMA tentativa o ML devolve várias causas e a ordem não é
    // garantida — o frete costuma vir de carona com o erro de verdade. Pegar a
    // primeira que casa faria a mensagem depender dessa ordem, então escolhemos
    // pela prioridade (ver `prioridadeDaCausa`).
    let melhor: { texto: string; peso: number } | null = null;
    for (const cause of causes) {
      const described = descrever(cause, fallbackCategoryId);
      if (!described) continue;
      const peso = prioridadeDaCausa(cause);
      if (!melhor || peso < melhor.peso) melhor = { texto: described, peso };
    }
    if (melhor) return melhor.texto;
  }
  return null;
}
