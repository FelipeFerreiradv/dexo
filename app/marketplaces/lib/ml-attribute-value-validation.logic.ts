/**
 * Pré-validação dos VALORES da ficha técnica contra o catálogo da categoria do
 * Mercado Livre, antes do POST /items.
 *
 * O preflight que já existia olha só "o campo obrigatório está presente?".
 * Nos logs de produção (16-22/09/2026) o ML recusou anúncios por VALORES que
 * a Dexo consegue ver antes de enviar:
 *   - 3510 lista: VEHICLE_TYPE "Linha Pesada" em categoria cujo único valor é
 *     "Carro/Caminhonete" (atributo `fixed`, 184 recusas); SIDE_POSITION com o
 *     id de OUTRA categoria (364128 "Esquerdo" onde a lista é
 *     42758042 "Esquerdo/Motorista");
 *   - 422 atributo do tipo imagem (`picture_id`) preenchido com "1" ou "0";
 *   - 3708 número sem unidade em atributo `number_unit` — em 152 de 242
 *     respostas com o aviso 306 veio junto o ERRO 3708, inclusive em campo
 *     opcional (Ângulo máximo de abertura, Amperagem);
 *   - 7711 GTIN com número de peça ("2033029", "9813203880") ou com o dígito
 *     verificador errado ("24434865", "94705894");
 *   - 395 mais de um código OEM onde a categoria aceita um só;
 *   - OEM repetido ("pé, pe", "t-cross, tcross", "porta-luvas, portaluvas"):
 *     o ML compara sem acento e sem hífen e recusa a repetição.
 *
 * Regras:
 *   - Correção automática SÓ quando o valor certo é determinado pela própria
 *     categoria (valor `fixed` único; id de lista trocado pelo de mesmo nome;
 *     "10,5 cm" → "10.5 cm"). Nada é inventado.
 *   - Todo o resto BLOQUEIA com mensagem que diz o campo, o valor e o que
 *     fazer. Decisão do Felipe (22/09/2026): valor inválido, mesmo em campo
 *     opcional, bloqueia até a correção — nada é omitido em silêncio.
 *   - Catálogo indisponível ou cache antigo sem o metadado da regra: a regra
 *     não roda (fail-open, igual ao resto do preflight).
 *
 * Puro: recebe o payload de atributos (já com o OEM em lista) e o catálogo
 * normalizado. Kill-switch no chamador: ML_VALUE_VALIDATION_DISABLED=1.
 */

export interface PayloadAttribute {
  id: string;
  value_id?: string | null;
  value_name?: string | null;
  values?: Array<{ id?: string | null; name?: string | null }>;
}

/** Subconjunto de `NormalizedMLAttribute` que as regras leem. */
export interface CatalogAttributeLite {
  id: string;
  name?: string;
  valueType?: string;
  fixedTag?: boolean;
  /** `tags.multivalued`; undefined = cache antigo = não se sabe. */
  multivaluedTag?: boolean;
  /** `tags.read_only`: o ML ignora o valor enviado (aviso 303). */
  readOnlyTag?: boolean;
  allowedValues?: Array<{ id: string; name: string }>;
  allowedUnits?: string[];
  defaultUnit?: string;
}

export type ValueIssueSeverity = "block" | "fix";

export type ValueIssueCode =
  | "FIXED_VALUE_NORMALIZED"
  | "LIST_ID_REMAPPED"
  | "LIST_VALUE_NOT_IN_CATEGORY"
  | "PICTURE_ATTRIBUTE_WITH_TEXT"
  | "NUMBER_WITHOUT_UNIT"
  | "NUMBER_DECIMAL_COMMA"
  | "GTIN_INVALID_FORMAT"
  | "OEM_DUPLICATE_VALUES"
  | "OEM_SINGLE_VALUE_ONLY";

export interface ValueIssue {
  attributeId: string;
  attributeName: string;
  severity: ValueIssueSeverity;
  code: ValueIssueCode;
  message: string;
  value?: string;
}

export interface ValueValidationResult {
  attributes: PayloadAttribute[];
  issues: ValueIssue[];
  blocked: boolean;
}

/**
 * Montados pela própria Dexo (SKU, condição, pacote a partir das medidas do
 * produto): fora das regras — mesma lista de ML_PAYLOAD_MANAGED_ATTRIBUTE_IDS.
 */
const PAYLOAD_MANAGED = new Set([
  "SELLER_SKU",
  "ITEM_CONDITION",
  "SELLER_PACKAGE_HEIGHT",
  "SELLER_PACKAGE_WIDTH",
  "SELLER_PACKAGE_LENGTH",
  "SELLER_PACKAGE_WEIGHT",
]);

const semAcento = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Comparação de NOME de valor de lista: sem acento, sem caixa, sem espaço extra. */
const chaveNome = (s: unknown): string =>
  semAcento(String(s ?? ""))
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * Como o ML compara tags OEM, até onde há prova: sem acento e sem hífen
 * ("pé"≡"pe", "t-cross"≡"tcross"). CAIXA É PRESERVADA — código de peça pode
 * ser case-significativo e não há prova de que o ML junte "AB123" e "ab123"
 * (mesma decisão de `splitOemTags`).
 */
const chaveOem = (s: unknown): string =>
  semAcento(String(s ?? ""))
    .replace(/-/g, "")
    .trim();

const unidadeChave = (s: string): string => semAcento(s).trim().toLowerCase();

function rotulo(cat: CatalogAttributeLite | undefined, id: string): string {
  return cat?.name?.trim() || id;
}

function valorTexto(a: PayloadAttribute): string {
  if (typeof a.value_name === "string") return a.value_name;
  if (Array.isArray(a.values)) {
    return a.values
      .map((v) => (v?.name ?? "").trim())
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

const NUMERO_UNIDADE = /^\s*-?\d+(?:[.,]\d+)?\s*(.*?)\s*$/;

function unidadeValida(raw: string, aceitas: string[]): boolean {
  const m = NUMERO_UNIDADE.exec(raw);
  if (!m || !m[1]) return false;
  const u = unidadeChave(m[1]);
  return aceitas.some((a) => unidadeChave(a) === u);
}

const GTIN = /^(\d{8}|\d{12}|\d{13}|\d{14})$/;

/**
 * Dígito verificador GS1 (GTIN-8/12/13/14). O ML confere: "24434865" e
 * "94705894" (8 dígitos, verificador errado) foram recusados com 7711 em
 * anúncios da Xaxim.
 */
export function gtinCheckDigitOk(gtin: string): boolean {
  if (!GTIN.test(gtin)) return false;
  const d = gtin.padStart(14, "0");
  let soma = 0;
  for (let i = 0; i < 13; i++) {
    soma += Number(d[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (soma % 10)) % 10 === Number(d[13]);
}

export function validateMLAttributeValues(
  attributes: PayloadAttribute[],
  catalog: CatalogAttributeLite[] | null | undefined,
): ValueValidationResult {
  const issues: ValueIssue[] = [];
  if (!Array.isArray(attributes)) {
    return { attributes, issues, blocked: false };
  }
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return { attributes, issues, blocked: false };
  }
  const porId = new Map(catalog.map((c) => [c.id, c]));
  const saida: PayloadAttribute[] = [];

  for (const attr of attributes) {
    const cat = attr && typeof attr.id === "string" ? porId.get(attr.id) : undefined;
    if (!attr || !cat || PAYLOAD_MANAGED.has(attr.id) || cat.readOnlyTag) {
      saida.push(attr);
      continue;
    }
    const nome = rotulo(cat, attr.id);

    // GTIN: só código de barras. O ML recusa (7711) qualquer outra coisa — no
    // caso real, número de peça ou texto digitado no campo.
    if (attr.id === "GTIN") {
      const valores = Array.isArray(attr.values)
        ? attr.values.map((v) => String(v?.name ?? "").trim()).filter(Boolean)
        : [String(attr.value_name ?? "").trim()].filter(Boolean);
      const invalido = valores.find((v) => !gtinCheckDigitOk(v));
      if (invalido !== undefined) {
        const soDigitoErrado = GTIN.test(invalido);
        issues.push({
          attributeId: attr.id,
          attributeName: nome,
          severity: "block",
          code: "GTIN_INVALID_FORMAT",
          message: soDigitoErrado
            ? `O campo ${nome} está com "${invalido}", que não é um código de barras válido (o dígito verificador não confere). Confira o número na embalagem ou apague o ${nome} na ficha técnica; se isso é o número da peça, use o campo Número da Peça.`
            : `O campo ${nome} aceita só código de barras (EAN/UPC, com 8, 12, 13 ou 14 dígitos) e está com "${invalido}". Se isso é o número da peça, apague o ${nome} na ficha técnica e use o campo Número da Peça.`,
          value: invalido,
        });
      }
      saida.push(attr);
      continue;
    }

    // Atributo do tipo imagem: a Dexo não envia imagem por aqui; qualquer
    // valor digitado é recusado (422 "invalid picture ID").
    if (cat.valueType === "picture_id") {
      const v = valorTexto(attr).trim() || String(attr.value_id ?? "").trim();
      if (v) {
        issues.push({
          attributeId: attr.id,
          attributeName: nome,
          severity: "block",
          code: "PICTURE_ATTRIBUTE_WITH_TEXT",
          message: `O campo "${nome}" da ficha técnica é do tipo imagem e está preenchido com "${v}". Apague esse valor na ficha técnica.`,
          value: v,
        });
      }
      saida.push(attr);
      continue;
    }

    const permitidos = cat.allowedValues ?? [];

    // Valor FIXO da categoria: o ML só aceita aquele (3510). Trocar pelo da
    // categoria é determinístico — é a própria categoria que diz qual é.
    if (cat.fixedTag && permitidos.length === 1) {
      const unico = permitidos[0];
      const temValor =
        (attr.value_id != null && String(attr.value_id).trim() !== "") ||
        (attr.value_name != null && String(attr.value_name).trim() !== "") ||
        (Array.isArray(attr.values) && attr.values.length > 0);
      const jaEhOUnico =
        String(attr.value_id ?? "") === unico.id ||
        (attr.value_id == null && chaveNome(attr.value_name) === chaveNome(unico.name));
      if (temValor && !jaEhOUnico) {
        issues.push({
          attributeId: attr.id,
          attributeName: nome,
          severity: "fix",
          code: "FIXED_VALUE_NORMALIZED",
          message: `"${nome}" nesta categoria só aceita "${unico.name}"; o valor "${valorTexto(attr) || attr.value_id}" foi trocado.`,
          value: valorTexto(attr) || String(attr.value_id ?? ""),
        });
        saida.push({ id: attr.id, value_id: unico.id, value_name: unico.name });
        continue;
      }
      saida.push(attr);
      continue;
    }

    // Lista FECHADA: id de outra categoria é recusado (3510). Nome idêntico a
    // um valor permitido ⇒ troca o id; senão bloqueia.
    if (
      cat.valueType === "list" &&
      permitidos.length > 0 &&
      attr.value_id != null &&
      String(attr.value_id).trim() !== "" &&
      !permitidos.some((p) => p.id === String(attr.value_id))
    ) {
      const mesmoNome = permitidos.filter(
        (p) => chaveNome(p.name) === chaveNome(attr.value_name),
      );
      if (mesmoNome.length === 1) {
        issues.push({
          attributeId: attr.id,
          attributeName: nome,
          severity: "fix",
          code: "LIST_ID_REMAPPED",
          message: `"${nome}": o valor "${attr.value_name}" foi ajustado para o código desta categoria.`,
          value: String(attr.value_name ?? ""),
        });
        saida.push({ ...attr, value_id: mesmoNome[0].id, value_name: mesmoNome[0].name });
        continue;
      }
      const opcoes = permitidos.slice(0, 6).map((p) => p.name).join(", ");
      issues.push({
        attributeId: attr.id,
        attributeName: nome,
        severity: "block",
        code: "LIST_VALUE_NOT_IN_CATEGORY",
        message: `O valor "${attr.value_name ?? attr.value_id}" do campo "${nome}" não existe nesta categoria do Mercado Livre (opções: ${opcoes}${permitidos.length > 6 ? "…" : ""}). Escolha uma das opções na ficha técnica.`,
        value: String(attr.value_name ?? attr.value_id ?? ""),
      });
      saida.push(attr);
      continue;
    }

    // Número com unidade (3708). Só com as unidades do catálogo em mãos.
    if (
      cat.valueType === "number_unit" &&
      Array.isArray(cat.allowedUnits) &&
      cat.allowedUnits.length > 0 &&
      typeof attr.value_name === "string" &&
      attr.value_name.trim() !== "" &&
      (attr.value_id == null || String(attr.value_id).trim() === "")
    ) {
      const v = attr.value_name;
      if (!unidadeValida(v, cat.allowedUnits)) {
        const exemplo = cat.defaultUnit || cat.allowedUnits[0];
        issues.push({
          attributeId: attr.id,
          attributeName: nome,
          severity: "block",
          code: "NUMBER_WITHOUT_UNIT",
          message: `O campo "${nome}" precisa de número com unidade (ex.: "10 ${exemplo}") e está com "${v}". Informe a unidade na ficha técnica ou apague o valor.`,
          value: v,
        });
        saida.push(attr);
        continue;
      }
      // "10,5 cm" → "10.5 cm": mesmo número, na forma que o ML lê.
      const virgula = /^(\s*-?\d+),(\d+)/;
      if (virgula.test(v)) {
        issues.push({
          attributeId: attr.id,
          attributeName: nome,
          severity: "fix",
          code: "NUMBER_DECIMAL_COMMA",
          message: `"${nome}": "${v}" enviado com ponto decimal.`,
          value: v,
        });
        saida.push({ ...attr, value_name: v.replace(virgula, "$1.$2") });
        continue;
      }
    }

    saida.push(attr);
  }

  // OEM em lista (applyOemTags já separou por vírgula e tirou o repetido
  // EXATO). Aqui entram as duas recusas que o ML faz e a Dexo não via.
  for (const a of saida) {
    if (!a || a.id !== "OEM" || !Array.isArray(a.values) || a.values.length < 2) {
      continue;
    }
    const oemCat = porId.get("OEM");
    const nome = rotulo(oemCat, "OEM");
    const vistos = new Map<string, string>();
    const repetidos: string[] = [];
    for (const v of a.values) {
      const bruto = String(v?.name ?? "").trim();
      const k = chaveOem(bruto);
      if (!k) continue;
      const anterior = vistos.get(k);
      if (anterior !== undefined) repetidos.push(`${anterior}, ${bruto}`);
      else vistos.set(k, bruto);
    }
    if (repetidos.length > 0) {
      issues.push({
        attributeId: "OEM",
        attributeName: nome,
        severity: "block",
        code: "OEM_DUPLICATE_VALUES",
        message: `O campo ${nome} tem o mesmo código repetido ("${repetidos[0]}"), e o Mercado Livre não aceita repetição (ele ignora acento e hífen). Deixe só uma das grafias no campo Código OEM.`,
        value: repetidos[0],
      });
    }
    if (oemCat?.multivaluedTag === false) {
      issues.push({
        attributeId: "OEM",
        attributeName: nome,
        severity: "block",
        code: "OEM_SINGLE_VALUE_ONLY",
        message: `Nesta categoria o Mercado Livre aceita só 1 código no campo ${nome}, e o produto tem ${a.values.length}. Deixe um código só no campo Código OEM.`,
      });
    }
  }

  return {
    attributes: saida,
    issues,
    blocked: issues.some((i) => i.severity === "block"),
  };
}

/** Mensagem única para a pessoa a partir dos bloqueios (null = nenhum). */
export function summarizeValueBlocks(issues: ValueIssue[]): string | null {
  const bloqueios = issues.filter((i) => i.severity === "block");
  if (bloqueios.length === 0) return null;
  if (bloqueios.length === 1) {
    return `${bloqueios[0].message} Depois de corrigir, a publicação é retomada.`;
  }
  return (
    `A ficha técnica tem ${bloqueios.length} valores que o Mercado Livre não aceita: ` +
    bloqueios.map((b) => b.message).join(" ") +
    " Depois de corrigir, a publicação é retomada."
  );
}

/**
 * Medidas do pacote implausíveis (o 5401 do ML: parabarro de 904 cm, suporte
 * de 116 kg). Só AVISO em log: bloquear pararia publicações que o ML aceita
 * hoje; a recusa, quando vem, já tem mensagem clara.
 */
export const PACKAGE_MAX_SIDE_CM = 200;
export const PACKAGE_MAX_WEIGHT_KG = 70;

export function packagePlausibilityWarnings(d: {
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | string | null;
}): string[] {
  const avisos: string[] = [];
  const lados: Array<[string, number | null | undefined]> = [
    ["altura", d.heightCm],
    ["largura", d.widthCm],
    ["comprimento", d.lengthCm],
  ];
  for (const [nome, v] of lados) {
    if (typeof v === "number" && Number.isFinite(v) && v > PACKAGE_MAX_SIDE_CM) {
      avisos.push(`${nome} ${v} cm > ${PACKAGE_MAX_SIDE_CM} cm`);
    }
  }
  const peso = Number(d.weightKg);
  if (Number.isFinite(peso) && peso > PACKAGE_MAX_WEIGHT_KG) {
    avisos.push(`peso ${peso} kg > ${PACKAGE_MAX_WEIGHT_KG} kg`);
  }
  return avisos;
}
