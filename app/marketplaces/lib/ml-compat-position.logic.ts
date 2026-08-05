/**
 * Posição das COMPATIBILIDADES do Mercado Livre.
 *
 * Não confundir com `ml-position.logic.ts`, deste mesmo diretório: lá é o
 * atributo POSITION do ITEM (um campo da ficha técnica, inferido do nome do
 * produto). Aqui é a restrição de posição de cada VEÍCULO compatível — o modal
 * "Adicione as posições" da Central de Vendedores. Os dois usam as mesmas
 * palavras ("Dianteira", "Esquerda") e não têm nenhuma outra relação; por isso
 * todo nome exportado daqui carrega o prefixo `CompatPosition`.
 *
 * CONTRATO MEDIDO EM PRODUÇÃO (05/08/2026, sonda `probe-ml-compat-positions`):
 *
 *   PUT /user-products/{up}/compatibilities
 *   { "create": { "products": [{ "id": "MLB22568426",
 *       "creation_source": "DEFAULT",
 *       "restrictions": [{ "attribute_id": "POSITION", "attribute_values": [
 *         { "values": [{ "value_id": "13701104", "value_name": "Dianteira" },
 *                      { "value_id": "2262158",  "value_name": "Esquerda"  }] }
 *       ]}] }], "universal": false } }
 *
 * Cada entrada de `attribute_values` é UMA posição; os `values` dentro dela são
 * os rótulos COMBINADOS dessa posição ("Dianteira esquerda" = dois valores numa
 * entrada só). Como o escopo aqui é uma posição por produto, `attribute_values`
 * sempre sai com exatamente uma entrada.
 *
 * ARMADILHA QUE JUSTIFICA METADE DESTE ARQUIVO: com `value_id` inválido o ML
 * responde **200 com `restrictions: []`** — aceita o corpo e descarta o conteúdo
 * em silêncio. Não dá para confiar no status HTTP nem no `inspectCompatWriteResponse`,
 * que declara sucesso só por ver o `id` ecoado e é cego a `restrictions`. Daí
 * `inspectRestrictionsEcho`, que confere o que voltou.
 *
 * Os `value_id` NÃO são constantes: mudam por par de domínios (veículo × peça).
 * Por isso o produto guarda RÓTULOS e a resolução acontece no envio, contra
 * GET /catalog_compatibilities/restrictions/values. Nada aqui tem rede.
 */

/** Uma posição já resolvida para o par de domínios em questão. */
export interface CompatPositionValue {
  value_id: string;
  value_name: string;
}

/** O bloco `restrictions` do corpo de escrita. */
export interface CompatRestrictionBlock {
  attribute_id: string;
  attribute_values: Array<{ values: CompatPositionValue[] }>;
}

/** `attribute_id` da restrição de posição. É o único que o ML expõe hoje. */
export const COMPAT_POSITION_ATTRIBUTE_ID = "POSITION";

/**
 * Teto de rótulos combinados numa posição. Vem do contrato do ML (`combined_values`
 * nunca passa de 4 no dump) e existe para o operador não montar uma posição que o
 * ML recusaria — ou pior, aceitaria e descartaria.
 */
export const COMPAT_POSITION_MAX_VALUES = 4;

/**
 * Os rótulos do modal da Central de Vendedores, na grafia que a API devolve
 * para o par MLB-CARS_AND_VANS × MLB-VEHICLE_HEADLIGHTS (medida na sonda: os 12
 * existem).
 *
 * Atenção à grafia: o ML escreve "Interno", "Externo" e "Intermédio" — não
 * "Interna", "Externa", "Intermediária". Guardamos e exibimos a grafia dele
 * para o vendedor ver a mesma palavra aqui e no painel do ML. O casamento é por
 * RAIZ (ver `compatPositionRoot`), então um valor gravado na outra flexão
 * continua resolvendo.
 */
export const COMPAT_POSITION_LABELS = [
  "Dianteira",
  "Traseira",
  "Esquerda",
  "Direita",
  "Motorista",
  "Passageiro",
  "Interno",
  "Externo",
  "Superior",
  "Inferior",
  "Intermédio",
  "Centro",
] as const;

export type CompatPositionLabel = (typeof COMPAT_POSITION_LABELS)[number];

/**
 * Pares mutuamente exclusivos.
 *
 * A fonte da verdade é o `opposite_values` que a API devolve por par de
 * domínios; esta tabela é a cópia estática usada pela UI, que não tem como
 * consultar a API a cada clique. As duas concordaram nos 5 pares medidos.
 * "Intermédio" e "Centro" não têm oposto — é o que a API devolve, e não uma
 * omissão.
 */
export const COMPAT_POSITION_OPPOSITES: ReadonlyArray<
  readonly [CompatPositionLabel, CompatPositionLabel]
> = [
  ["Dianteira", "Traseira"],
  ["Esquerda", "Direita"],
  ["Motorista", "Passageiro"],
  ["Interno", "Externo"],
  ["Superior", "Inferior"],
] as const;

/** NFD + remoção de diacríticos + trim + lowercase. */
function normalize(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Reduz um rótulo à raiz, apagando a flexão de gênero.
 *
 * O mesmo conceito aparece como "Interno" ou "Interna" conforme quem escreveu
 * (a API, o modal do ML, o operador), e comparar as strings cruas erraria por
 * causa de uma vogal. Mesma técnica do `root()` de `ml-position.logic.ts`.
 */
export function compatPositionRoot(label: string): string {
  const n = normalize(label);
  if (!n) return "";
  if (/^dianteir/.test(n) || n === "frente") return "diant";
  if (/^traseir/.test(n) || n === "tras") return "tras";
  if (/^esquerd/.test(n)) return "esq";
  if (/^direit/.test(n)) return "dir";
  if (/^motorista/.test(n)) return "motorista";
  if (/^passageir/.test(n)) return "passageiro";
  if (/^intern/.test(n)) return "intern";
  if (/^extern/.test(n)) return "extern";
  if (/^superior/.test(n)) return "superior";
  if (/^inferior/.test(n)) return "inferior";
  if (/^intermedi/.test(n)) return "intermedio";
  if (/^centr/.test(n)) return "centro";
  return n;
}

/** Índice raiz → rótulo canônico, montado uma vez. */
const ROOT_TO_LABEL = new Map<string, CompatPositionLabel>(
  COMPAT_POSITION_LABELS.map((l) => [compatPositionRoot(l), l]),
);

/** Índice raiz → raiz do oposto, para a guarda de exclusão mútua. */
const ROOT_TO_OPPOSITE_ROOT = new Map<string, string>();
for (const [a, b] of COMPAT_POSITION_OPPOSITES) {
  ROOT_TO_OPPOSITE_ROOT.set(compatPositionRoot(a), compatPositionRoot(b));
  ROOT_TO_OPPOSITE_ROOT.set(compatPositionRoot(b), compatPositionRoot(a));
}

/**
 * O rótulo `candidate` conflita com algum dos já escolhidos?
 *
 * Usado pela UI para desabilitar a opção oposta em vez de deixar o operador
 * montar uma posição impossível ("Esquerda + Direita") e descobrir só depois.
 */
export function conflictsWithCompatPositions(
  selected: readonly string[],
  candidate: string,
): boolean {
  const oposto = ROOT_TO_OPPOSITE_ROOT.get(compatPositionRoot(candidate));
  if (!oposto) return false;
  return (selected || []).some((s) => compatPositionRoot(s) === oposto);
}

/**
 * Normaliza a lista vinda do cliente ou do banco.
 *
 * Descarta o que não é string, o que não casa com nenhum rótulo conhecido, os
 * repetidos (por raiz, então "Interna" e "Interno" contam como um) e o que
 * conflita com um rótulo já aceito. Corta em `COMPAT_POSITION_MAX_VALUES`.
 * Preserva a ordem de escolha. Devolve sempre array novo.
 *
 * Descartar o conflitante é seguro porque a UI já impede a combinação: chegar
 * aqui com "Esquerda + Direita" significa requisição montada à mão. O que NÃO
 * pode acontecer em silêncio é o envio ao ML — esse é conferido pelo eco.
 */
export function sanitizeCompatPositions(raw: unknown): CompatPositionLabel[] {
  if (!Array.isArray(raw)) return [];
  const out: CompatPositionLabel[] = [];
  const vistos = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const raiz = compatPositionRoot(item);
    const canonico = ROOT_TO_LABEL.get(raiz);
    if (!canonico) continue;
    if (vistos.has(raiz)) continue;
    if (conflictsWithCompatPositions(out, canonico)) continue;
    vistos.add(raiz);
    out.push(canonico);
    if (out.length >= COMPAT_POSITION_MAX_VALUES) break;
  }
  return out;
}

/**
 * Casa os rótulos escolhidos contra os valores que a API publicou para o par de
 * domínios.
 *
 * Devolve os resolvidos na ordem escolhida e os que ficaram de fora. Resolver
 * PARCIALMENTE é aceitável e proposital: nem toda categoria de peça expõe os 12
 * rótulos, e mandar "Dianteira" sozinha é melhor do que não mandar posição
 * nenhuma. O que não é aceitável é fingir que mandou tudo — daí `unresolved`
 * voltar para quem chamou registrar.
 */
export function resolveCompatPositions(
  labels: readonly string[],
  allowed: ReadonlyArray<{ value_id?: unknown; value_name?: unknown }>,
): { resolved: CompatPositionValue[]; unresolved: string[] } {
  const porRaiz = new Map<string, CompatPositionValue>();
  for (const v of allowed || []) {
    const id = v?.value_id;
    const name = v?.value_name;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    const raiz = compatPositionRoot(name);
    if (!raiz || porRaiz.has(raiz)) continue;
    porRaiz.set(raiz, { value_id: id, value_name: name });
  }

  const resolved: CompatPositionValue[] = [];
  const unresolved: string[] = [];
  for (const label of labels || []) {
    const hit = porRaiz.get(compatPositionRoot(label));
    if (hit) resolved.push(hit);
    else unresolved.push(label);
  }
  return { resolved, unresolved };
}

/**
 * Monta o bloco `restrictions`. `null` quando não há posição resolvida — e
 * `null` é o que mantém o corpo do PUT byte-idêntico ao de hoje para todo
 * produto sem posição, que é a esmagadora maioria.
 */
export function buildCompatRestrictions(
  values: readonly CompatPositionValue[],
): CompatRestrictionBlock[] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const limitados = values.slice(0, COMPAT_POSITION_MAX_VALUES);
  return [
    {
      attribute_id: COMPAT_POSITION_ATTRIBUTE_ID,
      // Uma posição por produto: sempre exatamente uma entrada, com os rótulos
      // combinados dentro dela.
      attribute_values: [{ values: limitados.map((v) => ({ ...v })) }],
    },
  ];
}

/**
 * O ML de fato gravou as posições que mandamos?
 *
 * Existe porque a resposta de sucesso e a de descarte silencioso são ambas 200:
 * quando um `value_id` não vale para o par de domínios, o corpo volta com
 * `restrictions: []` dentro do produto e o `id` ecoado normalmente — que é
 * justamente o que `inspectCompatWriteResponse` lê como sucesso.
 *
 * - "echoed":  algum produto voltou com restrição preenchida.
 * - "dropped": o produto voltou com `restrictions` presente e VAZIA.
 * - "unknown": a resposta não traz a chave. Não reprovamos por falta de
 *   evidência — mesma regra do `inspectCompatWriteResponse`, e é o que mantém
 *   mocks de teste e formatos novos fora do balde de erro.
 */
export function inspectRestrictionsEcho(data: unknown): {
  verdict: "echoed" | "dropped" | "unknown";
  count: number;
} {
  if (!data || typeof data !== "object") return { verdict: "unknown", count: 0 };
  const root = data as Record<string, unknown>;
  const scope =
    root.create && typeof root.create === "object"
      ? (root.create as Record<string, unknown>)
      : root;
  const produtos = scope.products;
  if (!Array.isArray(produtos) || produtos.length === 0) {
    return { verdict: "unknown", count: 0 };
  }

  let viuChave = false;
  let total = 0;
  for (const p of produtos) {
    if (!p || typeof p !== "object") continue;
    const restrictions = (p as Record<string, unknown>).restrictions;
    if (!Array.isArray(restrictions)) continue;
    viuChave = true;
    for (const r of restrictions) {
      if (!r || typeof r !== "object") continue;
      const values = (r as Record<string, unknown>).attribute_values;
      if (Array.isArray(values)) total += values.length;
    }
  }

  if (!viuChave) return { verdict: "unknown", count: 0 };
  return total > 0
    ? { verdict: "echoed", count: total }
    : { verdict: "dropped", count: 0 };
}
