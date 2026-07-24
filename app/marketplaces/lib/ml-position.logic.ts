/**
 * Inferência de lado/posição da peça a partir do nome do produto.
 *
 * O atributo de posição varia por categoria no ML: em algumas é `POSITION` com
 * valores compostos ("Dianteira esquerda"), em outras a categoria simplesmente
 * não expõe o campo. Por isso nada aqui decide SOZINHO se o atributo vai no
 * payload — quem decide é o catálogo da categoria
 * (GET /categories/{id}/attributes). Este módulo só traduz texto livre em um
 * candidato, e casa esse candidato contra os valores oficiais da categoria.
 *
 * Puro de propósito (sem rede, sem React): é o que permite testar a matriz de
 * combinações sem mockar o catálogo do ML.
 */

/** Candidato de posição pronto para virar entrada de `attributes[]`. */
export interface PositionCandidate {
  valueId?: string;
  valueName: string;
}

/** Opção oficial de valor vinda de GET /categories/{id}/attributes. */
export interface PositionAllowedValue {
  id: string;
  name: string;
}

/** NFD + remoção de diacríticos + trim + lowercase. */
function normalize(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

const RE_FRENTE = /dianteir|frente/;
const RE_TRAS = /traseir|tras|trás/;
// `\ble\b`/`\bld\b` são as abreviações de lado usadas em anúncio de autopeça
// (Lado Esquerdo / Lado Direito). Exigem fronteira de palavra para não casar
// dentro de "leve", "solda" etc.
const RE_ESQ = /esquerd|\ble\b/;
const RE_DIR = /direit|\bld\b/;

/**
 * Traduz o nome do produto no rótulo de posição mais específico possível.
 *
 * A ordem importa: combinações (eixo + lado) são testadas antes dos eixos
 * isolados, senão "Farol dianteiro esquerdo" pararia em "Dianteira" e perderia
 * o lado — que é exatamente a informação que o comprador filtra.
 *
 * "Dianteira" e "Traseira" sozinhas são os dois valores que o sistema já
 * inferia antes desta função existir; continuam produzindo o mesmo rótulo.
 *
 * Retorna null quando o nome não diz nada sobre posição — nesse caso nada deve
 * ser enviado ao ML.
 */
export function inferPositionFromName(name: string): string | null {
  const n = normalize(name);
  if (!n) return null;

  const frente = RE_FRENTE.test(n);
  const tras = RE_TRAS.test(n);
  const esq = RE_ESQ.test(n);
  const dir = RE_DIR.test(n);

  // Ambíguo nos dois eixos ou nos dois lados: não arrisca um palpite errado.
  if (frente && tras) return null;
  if (esq && dir) return null;

  if (frente && esq) return "Dianteira esquerda";
  if (frente && dir) return "Dianteira direita";
  if (tras && esq) return "Traseira esquerda";
  if (tras && dir) return "Traseira direita";
  if (frente) return "Dianteira";
  if (tras) return "Traseira";
  if (esq) return "Esquerda";
  if (dir) return "Direita";
  return null;
}

/**
 * Reduz um token à sua raiz, apagando a flexão de gênero. O ML escreve o mesmo
 * conceito como "Esquerda" (posição) ou "Esquerdo" (lado) conforme o atributo,
 * e comparar as strings cruas erraria por causa de uma vogal.
 */
function root(token: string): string {
  if (/^dianteir/.test(token) || token === "frente") return "diant";
  if (/^traseir/.test(token) || token === "tras") return "tras";
  if (/^esquerd/.test(token)) return "esq";
  if (/^direit/.test(token)) return "dir";
  return token;
}

function tokenRoots(s: string): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(root);
}

function sameRoots(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t) => b.includes(t));
}

/**
 * Casa o rótulo inferido contra os valores oficiais da categoria.
 *
 * Tenta do mais informativo para o menos: o rótulo inteiro, depois só o lado,
 * depois só o eixo. Essa degradação existe porque o atributo varia por
 * categoria — uma categoria com `SIDE` (Esquerdo/Direito) não tem onde colocar
 * "Dianteira", e enviar o lado sozinho é melhor do que não enviar nada.
 *
 * Regra de segurança: quando a categoria publica uma lista fechada e nenhum
 * candidato casa, devolvemos null — em vez de mandar um `value_name` livre que
 * o ML rejeitaria (ou pior, aceitaria e ignoraria, que é o mesmo tipo de falha
 * silenciosa da compatibilidade).
 *
 * Sem lista de valores (categoria de texto livre), devolve só o `value_name`.
 */
export function resolvePositionValue(
  inferred: string,
  allowedValues?: PositionAllowedValue[],
): PositionCandidate | null {
  const label = (inferred || "").trim();
  if (!label) return null;

  if (!Array.isArray(allowedValues) || allowedValues.length === 0) {
    return { valueName: label };
  }

  const parts = label.split(/\s+/).filter(Boolean);
  const candidates: string[] = [label];
  if (parts.length > 1) {
    // "Dianteira esquerda" → tenta "esquerda" (lado) e depois "dianteira".
    candidates.push(parts.slice(1).join(" "), parts[0]);
  }

  for (const candidate of candidates) {
    const roots = tokenRoots(candidate);
    const hit = allowedValues.find((v) =>
      sameRoots(roots, tokenRoots(v?.name ?? "")),
    );
    if (hit) return { valueId: hit.id, valueName: hit.name };
  }

  return null;
}
