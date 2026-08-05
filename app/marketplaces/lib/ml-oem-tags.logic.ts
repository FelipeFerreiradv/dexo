/**
 * Código OEM como LISTA de tags no payload do Mercado Livre.
 *
 * O atributo `OEM` do ML é `multivalued: true` (levantado na API real:
 * `value_type: "string"`, `value_max_length: 255` POR VALOR). O formato de envio
 * multivalorado é `{ id, values: [{ name }, ...] }` — é por isso que na Central
 * de Vendedores o campo aparece como chips separados. Enviar
 * `value_name: "farol, dianteiro, direito"` faz o ML guardar UMA tag só, com as
 * vírgulas dentro.
 *
 * O operador continua digitando separado por vírgula, e o valor continua sendo
 * ARMAZENADO assim em `Product.attributes`. A conversão para lista acontece só
 * na montagem do payload — por isso este módulo é puro (sem rede, sem env, sem
 * React), no mesmo padrão de `ml-position.logic.ts`.
 *
 * REGRA DE UM TOKEN SÓ: quando não há vírgula, a entrada continua saindo como
 * `value_name` singular, byte-idêntica ao que já vai hoje. Praticamente todo
 * produto cadastrado tem um código único; manter o singular restringe a mudança
 * ao caso que está comprovadamente errado.
 */

/** Entrada de `attributes[]` do payload do ML, no shape que já usamos hoje. */
export interface MLAttributeEntry {
  id: string;
  value_id?: string;
  value_name?: string;
  values?: Array<{ id?: string; name?: string }>;
}

/**
 * Quebra o texto do campo em tags.
 *
 * Só vírgula separa: `-` e `/` aparecem DENTRO de código OEM legítimo
 * (ex.: "5U0-121049", "A/B 123") e usá-los como separador destruiria o dado.
 *
 * Dedup é EXATO, sem normalizar caixa nem acento — código de peça pode ser
 * case-significativo, e descartar "AB123" porque veio junto de "ab123" seria
 * perda silenciosa. A ordem digitada é preservada (vence a primeira ocorrência).
 */
export function splitOemTags(raw: string): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const parte of raw.split(",")) {
    const tag = parte.trim();
    if (!tag || vistos.has(tag)) continue;
    vistos.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Devolve os atributos com as entradas de código OEM convertidas para lista.
 *
 * PURA E IDEMPOTENTE: sempre devolve um array NOVO, e uma entrada que já esteja
 * em `values` volta como está. As duas coisas importam porque a escada de retry
 * da publicação reprocessa o mesmo array várias vezes.
 *
 * Só mexe nos ids informados em `oemIds` — qualquer outro atributo passa intacto.
 */
export function applyOemTags(
  attrs: MLAttributeEntry[],
  oemIds: ReadonlySet<string>,
): MLAttributeEntry[] {
  if (!Array.isArray(attrs) || attrs.length === 0) return [];
  return attrs.map((attr) => {
    if (!attr || !oemIds.has(attr.id)) return attr;
    // Já é lista: idempotência.
    if (Array.isArray(attr.values)) return attr;
    const tags = splitOemTags(attr.value_name ?? "");
    // 0 tags: nada a converter (o atributo nem deveria estar aqui).
    // 1 tag: mantém o singular — caminho de hoje, byte-idêntico.
    if (tags.length < 2) return attr;
    const { value_name: _descartado, value_id: _idDescartado, ...resto } = attr;
    return { ...resto, values: tags.map((name) => ({ name })) };
  });
}
