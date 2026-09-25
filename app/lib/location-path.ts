/**
 * Caminho completo de uma localização ("Galpão 1 > Andar 1 > Caixa 212"),
 * subindo pela cadeia de `parentId`.
 *
 * ⚠️ Em vários clientes o CÓDIGO da localização já é o caminho inteiro: a
 * filha de "BARR." se chama "BARR. > CORR.-B", e a neta,
 * "BARR. > CORR.-B > PRT.-57". Colar os códigos um atrás do outro repetia os
 * trechos ("BARR. > BARR. > CORR.-B > BARR. > CORR.-B > PRT.-57"). Medido em
 * 25/09/2026: 2.108 localizações de 7 clientes, 20.948 produtos.
 *
 * Regra, por segmento (" > "), sem diferenciar maiúsculas nem espaços:
 * - código que começa pelo caminho do pai E vai além dele → o código É o
 *   caminho;
 * - código que começa pelo código do pai e vai além dele (pai de código
 *   curto, avô acima) → caminho do pai + o que vem depois do código do pai;
 * - senão → caminho do pai + " > " + código (comportamento de sempre).
 *   Cadeia sem nenhum código com " > " cai sempre aqui: resultado idêntico
 *   ao montador antigo (em PROD, 25/09: 0 códigos vazios, 0 com espaço nas
 *   pontas, 0 com ">" fora do padrão " > ", 0 filhos iguais ao pai).
 *
 * Função pura, sem Prisma: o chamador entrega os nós que tiver.
 */

export interface LocationPathNode {
  id: string;
  code: string;
  parentId?: string | null;
}

const SEPARATOR = " > ";
/** Mesma proteção do montador anterior contra cadeia longa ou ciclo. */
const MAX_DEPTH = 25;

/** Só o separador com espaço conta: "CX>10" é um código, não um caminho. */
function segments(value: string): string[] {
  return value
    .split(/\s+>\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function segmentKey(segment: string): string {
  return segment.replace(/\s+/g, " ").toUpperCase();
}

/**
 * `whole` começa por todos os segmentos de `prefix` e tem MAIS segmentos?
 * Igual não conta: filho "a1" sob pai "A1" continua "A1 > a1", como sempre.
 */
function startsWithSegments(whole: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || prefix.length >= whole.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (segmentKey(whole[i]) !== segmentKey(prefix[i])) return false;
  }
  return true;
}

/**
 * Devolve `id → caminho`. Nó ausente devolve "" (o chamador decide o
 * fallback). Cada caminho é calculado uma vez.
 */
export function createLocationPathResolver(
  nodes: Iterable<LocationPathNode>,
): (id: string) => string {
  const byId = new Map<string, LocationPathNode>();
  for (const node of nodes) byId.set(node.id, node);
  const cache = new Map<string, string>();

  const resolve = (id: string, depth: number, seen: Set<string>): string => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (!node) return "";

    const code = (node.code ?? "").trim();
    const parent =
      node.parentId != null && !seen.has(node.parentId) && depth < MAX_DEPTH
        ? byId.get(node.parentId)
        : undefined;

    let path = code;
    if (parent) {
      seen.add(id);
      const parentPath = resolve(parent.id, depth + 1, seen);
      if (parentPath) {
        const own = segments(code);
        const parentSegs = segments(parentPath);
        const parentCodeSegs = segments(parent.code ?? "");
        if (startsWithSegments(own, parentSegs)) {
          path = own.join(SEPARATOR);
        } else if (
          parentCodeSegs.length < parentSegs.length &&
          startsWithSegments(own, parentCodeSegs)
        ) {
          const rest = own.slice(parentCodeSegs.length);
          path = `${parentPath}${SEPARATOR}${rest.join(SEPARATOR)}`;
        } else {
          path = code ? `${parentPath}${SEPARATOR}${code}` : parentPath;
        }
      }
    }

    cache.set(id, path);
    return path;
  };

  return (id: string) => resolve(id, 0, new Set());
}

/**
 * O caminho do jeito ANTIGO (códigos colados com " > "), que é o que
 * `LocationUseCase.buildFullPathLean` ainda grava em `Product.location` ao
 * mover/vincular peça. Serve só para reconhecer esse texto como "o mesmo
 * lugar" — nunca para exibir.
 */
export function createLegacyLocationPathResolver(
  nodes: Iterable<LocationPathNode>,
): (id: string) => string {
  const byId = new Map<string, LocationPathNode>();
  for (const node of nodes) byId.set(node.id, node);
  return (id: string) => {
    const parts: string[] = [];
    let cur: string | null | undefined = id;
    let guard = 0;
    while (cur && guard++ < MAX_DEPTH) {
      const node = byId.get(cur);
      if (!node) break;
      parts.unshift(node.code);
      cur = node.parentId;
    }
    return parts.join(SEPARATOR);
  };
}
