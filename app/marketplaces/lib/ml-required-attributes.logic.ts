/**
 * Atributos obrigatórios do Mercado Livre — a regra que decide, ANTES do
 * POST /items, se a ficha técnica montada para a categoria está completa.
 *
 * Por que existe: o preflight antigo (listing-preflight.service.ts) lê o
 * `required` LARGO do cache (`required || catalog_required || fixed`). Medido
 * em setembro/2026, essa régua barraria MOUNT_TYPE (só `catalog_required`, que
 * não é exigido fora do anúncio de catálogo) e VEHICLE_TYPE (`fixed`, que o
 * próprio ML preenche) — anúncios que publicavam normalmente. Por isso o modo
 * `strict` nunca pôde ser ligado, e o operador só descobria o Part Number em
 * branco depois de gastar a escada inteira de retentativas.
 *
 * A régua daqui é a ESTRITA: só `tags.required` sem `tags.fixed`. Tudo que não
 * dá para afirmar com certeza vira aviso ou "unknown" — nunca bloqueio:
 *   - linha antiga do cache (sem os booleanos novos) → `tags_unknown`;
 *   - catálogo indisponível → `catalog_unavailable`;
 *   - atributos universais (SOFT_REQUIRED), ocultos e `conditional_required`.
 * O que escapar daqui é pego depois do POST pela causa 147 do próprio ML.
 *
 * Módulo PURO (sem prisma, axios ou services — só `import type`): é importado
 * também pelo front (`mlAttributeFormField`) e pelo script de prova.
 * Não tem efeito sozinho: só é chamado por código atrás de
 * `ML_REQUIRED_ATTRS_BLOCK=1`.
 */

export const ML_REQUIRED_ATTRS_BLOCK_ENV = "ML_REQUIRED_ATTRS_BLOCK";

/** `code` do resultado/linha do relatório quando o bloqueio é por obrigatório. */
export const ML_REQUIRED_ATTRS_ERROR_CODE =
  "ML_REQUIRED_ATTRIBUTES_MISSING" as const;

/** M10 — quando o ML devolve a causa 147 sem ids legíveis. */
export const ML_REQUIRED_ATTRS_GENERIC_MESSAGE =
  "Esta categoria do Mercado Livre exige campos obrigatórios que não foram preenchidos. Confira a ficha técnica do produto antes de publicar o anúncio.";

/**
 * Lida a CADA chamada (rollback sem deploy: tirar a variável e reiniciar).
 * Só o literal "1" liga — "true" NÃO, de propósito: é o mesmo padrão dos
 * kill-switches `*_DISABLED=1` do projeto, e evita ligar por engano quem
 * copiar a convenção `ML_CATALOG_LISTING_ENABLED=true`.
 */
export function isMlRequiredAttrsBlockEnabled(
  env?: Record<string, string | undefined>,
): boolean {
  const fonte =
    env ??
    (typeof process !== "undefined" && process?.env
      ? (process.env as Record<string, string | undefined>)
      : {});
  return fonte[ML_REQUIRED_ATTRS_BLOCK_ENV] === "1";
}

/**
 * Atributo do catálogo da categoria com as tags cruas preservadas.
 * `NormalizedMLAttribute` (ml-attribute-catalog.service) é estruturalmente
 * compatível. `requiredTag` undefined = linha antiga do cache = tags
 * desconhecidas.
 */
export interface MLCategoryAttributeTags {
  id: string;
  name?: string;
  valueType?: string;
  hidden?: boolean;
  allowedValues?: Array<{ id: string; name: string }>;
  requiredTag?: boolean;
  catalogRequiredTag?: boolean;
  conditionalRequiredTag?: boolean;
  fixedTag?: boolean;
}

export interface MLPayloadAttribute {
  id: string;
  value_id?: string;
  value_name?: string;
  values?: Array<{ id?: string; name?: string }>;
}

export type MLRequiredAttributeReason = "missing" | "invalid_value";

export interface MLRequiredAttributeIssue {
  attributeId: string;
  attributeName: string;
  reason: MLRequiredAttributeReason;
  message: string;
}

export type MLRequiredAttributesStatus = "ok" | "blocked" | "unknown";

export type MLRequiredAttributesUnknownReason =
  | "catalog_unavailable"
  | "tags_unknown"
  | "category_unresolved"
  | "product_not_found"
  | "evaluation_failed";

export interface MLRequiredAttributesEvaluation {
  status: MLRequiredAttributesStatus;
  unknownReason?: MLRequiredAttributesUnknownReason;
  blocking: MLRequiredAttributeIssue[];
  warnings: MLRequiredAttributeIssue[];
  message: string | null;
}

/**
 * Ids que o payload preenche por OUTRO caminho que não `attributes[]` montado
 * antes do bloqueio: a condição vai no campo `condition`, o SKU em
 * `seller_custom_field`/SELLER_SKU e o pacote é acrescentado só DEPOIS (a partir
 * das medidas do produto, que já são obrigatórias no create). Bloquear por eles
 * antes do POST seria bloquear o que vai chegar.
 */
export const ML_PAYLOAD_MANAGED_ATTRIBUTE_IDS: ReadonlySet<string> = new Set([
  "ITEM_CONDITION",
  "SELLER_SKU",
  "SELLER_PACKAGE_HEIGHT",
  "SELLER_PACKAGE_WIDTH",
  "SELLER_PACKAGE_LENGTH",
  "SELLER_PACKAGE_WEIGHT",
]);

/**
 * Atributos cuja ausência no produto NÃO bloqueia — são universais
 * (marca genérica, tamanho, cor) e podem ser aceitos como "Não especificado"
 * pelo próprio ML sem rejeição.
 *
 * Movido de listing-preflight.service.ts (mesmo conteúdo, mesma ordem) para a
 * regra nova e o preflight antigo lerem a MESMA lista.
 */
export const ML_SOFT_REQUIRED_ATTRIBUTE_IDS: ReadonlySet<string> = new Set([
  "UNIT_OF_LENGTH",
  "COLOR",
  "MAIN_COLOR",
  "SIZE",
  "LENGTH",
  "WIDTH",
  "HEIGHT",
  "WEIGHT",
]);

const naoVazio = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Valor preenchido de verdade: `value_id` ou `value_name` com conteúdo, ou
 * `values[]` com alguma entrada que tenha id ou nome. Branco conta como
 * ausente — o ML trata `"  "` como campo vazio.
 */
export function attributeHasValue(
  v:
    | { value_id?: unknown; value_name?: unknown; values?: unknown }
    | null
    | undefined,
): boolean {
  if (!v || typeof v !== "object") return false;
  if (naoVazio(v.value_id) || naoVazio(v.value_name)) return true;
  if (Array.isArray(v.values)) {
    return v.values.some(
      (e) =>
        !!e &&
        typeof e === "object" &&
        (naoVazio((e as { id?: unknown }).id) ||
          naoVazio((e as { name?: unknown }).name)),
    );
  }
  return false;
}

/** NFD, sem acento, minúsculas, trim e espaços colapsados. */
export function normalizeAttributeValueName(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Lista FECHADA de verdade: `list`/`boolean` com valores publicados.
 *
 * NÃO é o `isListAttribute` do front (ml-dynamic-attributes.logic.ts), que
 * considera lista qualquer atributo com `values`. BRAND, por exemplo, é
 * `string` com valores SUGERIDOS — o ML aceita texto livre ali, e tratar como
 * lista fechada bloquearia toda marca fora das sugestões.
 */
export function isClosedListAttribute(attr: MLCategoryAttributeTags): boolean {
  return (
    (attr.valueType === "list" || attr.valueType === "boolean") &&
    Array.isArray(attr.allowedValues) &&
    attr.allowedValues.length > 0
  );
}

/**
 * O valor informado está entre os permitidos da categoria? Só faz sentido para
 * lista fechada (ver `isClosedListAttribute`).
 *   - com value_id: exige id idêntico;
 *   - senão, com value_name: compara pelo nome normalizado;
 *   - senão, com values[]: cada entrada preenchida casa por id ou nome.
 */
export function attributeValueIsAllowed(
  v: MLPayloadAttribute | { value_id?: unknown; value_name?: unknown; values?: unknown },
  attr: MLCategoryAttributeTags,
): boolean {
  const permitidos = Array.isArray(attr.allowedValues) ? attr.allowedValues : [];
  const casaId = (id: string) => permitidos.some((a) => a.id === id);
  const casaNome = (nome: string) => {
    const alvo = normalizeAttributeValueName(nome);
    return permitidos.some((a) => normalizeAttributeValueName(a.name) === alvo);
  };
  const valueId = (v as { value_id?: unknown }).value_id;
  if (naoVazio(valueId)) return casaId((valueId as string).trim());
  const valueName = (v as { value_name?: unknown }).value_name;
  if (naoVazio(valueName)) return casaNome(valueName as string);
  const values = (v as { values?: unknown }).values;
  if (Array.isArray(values)) {
    const preenchidas = values.filter(
      (e) =>
        !!e &&
        typeof e === "object" &&
        (naoVazio((e as { id?: unknown }).id) ||
          naoVazio((e as { name?: unknown }).name)),
    ) as Array<{ id?: string; name?: string }>;
    if (preenchidas.length === 0) return false;
    return preenchidas.every(
      (e) =>
        (naoVazio(e.id) && casaId(String(e.id).trim())) ||
        (naoVazio(e.name) && casaNome(String(e.name))),
    );
  }
  return false;
}

const SIDE_IDS = new Set(["SIDE", "VEHICLE_SIDE"]);
const POSICAO_IDS = new Set(["POSITION", "MOUNTING_POSITION", "PART_POSITION"]);

/**
 * Rótulos com artigo dos campos que o operador reconhece no cadastro. NÃO
 * reaproveita ATTR_LABELS de ml-error-message.service ("Número da Peça"): o
 * texto destas mensagens foi fixado pelo dono.
 */
const ROTULO_COM_ARTIGO: Record<string, string> = {
  PART_NUMBER: "do Part Number",
  MPN: "do Part Number",
  BRAND: "da Marca",
  MODEL: "do Modelo",
  YEAR: "do Ano",
  VEHICLE_YEAR: "do Ano",
  FUEL_TYPE: "do Tipo de combustível",
  OEM: "do Código OEM",
};

/** M1–M7 para um bloqueio individual. */
export function buildMLRequiredAttributeMessage(i: {
  attributeId: string;
  attributeName: string;
  reason: MLRequiredAttributeReason;
}): string {
  const nome = (i.attributeName || i.attributeId || "").trim() || i.attributeId;
  if (i.reason === "invalid_value") {
    if (SIDE_IDS.has(i.attributeId)) {
      // M6
      return "O lado da peça informado não é aceito por esta categoria. Selecione Direito ou Esquerdo antes de publicar o anúncio.";
    }
    // M7
    return `O valor informado em "${nome}" não é aceito por esta categoria do Mercado Livre. Escolha uma das opções da lista antes de continuar.`;
  }
  if (SIDE_IDS.has(i.attributeId)) {
    // M2 — texto do dono.
    return "Esta categoria exige o lado da peça. Selecione Direito ou Esquerdo antes de publicar o anúncio.";
  }
  if (POSICAO_IDS.has(i.attributeId)) {
    // M3
    return "Esta categoria exige a posição da peça. Selecione a posição antes de publicar o anúncio.";
  }
  const rotulo = ROTULO_COM_ARTIGO[i.attributeId];
  if (rotulo) {
    // M1 (Part Number, texto do dono) e M4.
    return `Esta categoria do Mercado Livre exige o preenchimento ${rotulo}. Preencha esse campo antes de continuar.`;
  }
  // M5
  return `Esta categoria do Mercado Livre exige o preenchimento do campo "${nome}". Preencha esse campo antes de continuar.`;
}

/** M8 — aviso de `conditional_required` (não bloqueia). */
export function buildMLConditionalAttributeWarning(
  attributeName: string,
): string {
  return `Esta categoria do Mercado Livre pode exigir o campo "${attributeName}", dependendo das outras informações do anúncio.`;
}

/** 0 → null; 1 → a mensagem; >1 → M9 (junção por espaço, na ordem recebida). */
export function summarizeMLRequiredAttributeIssues(
  blocking: ReadonlyArray<MLRequiredAttributeIssue>,
): string | null {
  if (!blocking || blocking.length === 0) return null;
  if (blocking.length === 1) return blocking[0].message;
  return blocking.map((b) => b.message).join(" ");
}

/**
 * Ids citados pela causa 147 do ML → issues com o nome do catálogo (ou o
 * próprio id quando o catálogo não o traz). Sem duplicar.
 */
export function issuesFromMissingAttributeIds(
  ids: string[],
  categoryAttributes?: ReadonlyArray<MLCategoryAttributeTags>,
): MLRequiredAttributeIssue[] {
  const porId = new Map(
    (categoryAttributes ?? []).map((a) => [a?.id, a] as const),
  );
  const vistos = new Set<string>();
  const out: MLRequiredAttributeIssue[] = [];
  for (const bruto of ids ?? []) {
    const id = String(bruto ?? "").trim();
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    const nome = porId.get(id)?.name?.trim() || id;
    const base = { attributeId: id, attributeName: nome, reason: "missing" as const };
    out.push({ ...base, message: buildMLRequiredAttributeMessage(base) });
  }
  return out;
}

/** Campo do formulário de produto onde o operador corrige o atributo. */
export function mlAttributeFormField(
  attributeId: string,
): "partNumber" | "brand" | "model" | "year" | "attributes" {
  switch (attributeId) {
    case "PART_NUMBER":
    case "MPN":
      return "partNumber";
    case "BRAND":
      return "brand";
    case "MODEL":
      return "model";
    case "YEAR":
    case "VEHICLE_YEAR":
      return "year";
    default:
      return "attributes";
  }
}

/**
 * Avalia o payload de atributos (já enriquecido, exatamente o que vai ao ML)
 * contra o catálogo da categoria.
 *
 * `catalogListing` existe para o dia em que o anúncio de catálogo levar
 * atributos; hoje todos os chamadores passam `false`, porque a tentativa de
 * catálogo não envia `attributes` e, quando falha, cai no payload tradicional.
 */
export function evaluateMLRequiredAttributes(input: {
  categoryAttributes: ReadonlyArray<MLCategoryAttributeTags> | null | undefined;
  payloadAttributes: ReadonlyArray<MLPayloadAttribute>;
  catalogListing: boolean;
}): MLRequiredAttributesEvaluation {
  const catalogo = input.categoryAttributes;
  if (!Array.isArray(catalogo) || catalogo.length === 0) {
    return {
      status: "unknown",
      unknownReason: "catalog_unavailable",
      blocking: [],
      warnings: [],
      message: null,
    };
  }

  // Basta UMA linha sem o booleano para a linha inteira ser do cache antigo —
  // e nela só existe o `required` largo, que é justamente o que NÃO pode
  // bloquear. Nunca cair nele.
  if (catalogo.some((a) => typeof a?.requiredTag !== "boolean")) {
    return {
      status: "unknown",
      unknownReason: "tags_unknown",
      blocking: [],
      warnings: [],
      message: null,
    };
  }

  const byId = new Map<string, MLPayloadAttribute>();
  for (const a of input.payloadAttributes ?? []) {
    if (a && typeof a.id === "string" && !byId.has(a.id)) byId.set(a.id, a);
  }

  const blocking: MLRequiredAttributeIssue[] = [];
  const warnings: MLRequiredAttributeIssue[] = [];
  const issue = (
    attr: MLCategoryAttributeTags,
    reason: MLRequiredAttributeReason,
  ): MLRequiredAttributeIssue => {
    const base = {
      attributeId: attr.id,
      attributeName: (attr.name || attr.id || "").trim() || attr.id,
      reason,
    };
    return { ...base, message: buildMLRequiredAttributeMessage(base) };
  };

  for (const attr of catalogo) {
    if (!attr || typeof attr.id !== "string") continue;
    if (ML_PAYLOAD_MANAGED_ATTRIBUTE_IDS.has(attr.id)) continue;

    const exige =
      attr.fixedTag !== true &&
      (attr.requiredTag === true ||
        (input.catalogListing && attr.catalogRequiredTag === true));
    const valor = byId.get(attr.id);
    const tem = attributeHasValue(valor);

    if (
      exige &&
      attr.hidden !== true &&
      !ML_SOFT_REQUIRED_ATTRIBUTE_IDS.has(attr.id)
    ) {
      if (!tem) {
        blocking.push(issue(attr, "missing"));
      } else if (
        isClosedListAttribute(attr) &&
        !attributeValueIsAllowed(valor as MLPayloadAttribute, attr)
      ) {
        blocking.push(issue(attr, "invalid_value"));
      }
    } else if (exige && !tem) {
      warnings.push(issue(attr, "missing"));
    } else if (attr.conditionalRequiredTag === true && !tem) {
      const nome = (attr.name || attr.id || "").trim() || attr.id;
      warnings.push({
        attributeId: attr.id,
        attributeName: nome,
        reason: "missing",
        message: buildMLConditionalAttributeWarning(nome),
      });
    }
  }

  return {
    status: blocking.length > 0 ? "blocked" : "ok",
    blocking,
    warnings,
    message: summarizeMLRequiredAttributeIssues(blocking),
  };
}

/**
 * Com `ML_CATALOG_LISTING_ENABLED=true` e produto vinculado a catálogo, a
 * primeira tentativa é o anúncio de catálogo — que NÃO envia atributos (herda
 * do produto do catálogo) e pode publicar com sucesso. Bloquear antes dela
 * barraria o que hoje publica; quem decide nesse caso é a causa 147 do POST
 * tradicional, se o catálogo falhar.
 */
export function shouldSkipMlRequiredBlockForCatalog(
  mlCatalogProductId: unknown,
  env?: Record<string, string | undefined>,
): boolean {
  const fonte =
    env ??
    (typeof process !== "undefined" && process?.env
      ? (process.env as Record<string, string | undefined>)
      : {});
  return (
    fonte.ML_CATALOG_LISTING_ENABLED === "true" &&
    typeof mlCatalogProductId === "string" &&
    mlCatalogProductId.trim().length > 0
  );
}
