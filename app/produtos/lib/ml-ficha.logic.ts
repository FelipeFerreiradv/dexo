/**
 * Ficha técnica do ML nos formulários (Revisão individual do "Anunciar em
 * massa" e "Editar produto"). Módulo PURO — a suíte não tem jsdom.
 *
 * Os dois formulários abriam a ficha VAZIA (Xaxim, 25/09/2026): a tela escondia
 * o que estava gravado no produto (INMETRO com texto de busca, medida "1" sem
 * unidade, texto no Código QR) e a pessoa não tinha como ver nem apagar. No
 * "Editar produto", salvar com a ficha mexida SUBSTITUÍA a ficha inteira só
 * pelo que foi digitado.
 */

export type MlFichaValue = { value_id?: string; value_name?: string };
export type MlFicha = Record<string, MlFichaValue>;

/**
 * Ficha gravada no produto → ficha inicial do formulário: só entradas com
 * `value_id`/`value_name` em texto não vazio. O que não tem essa forma (ex.:
 * `familyName` como string) fica de fora do formulário — e, como o formulário
 * só envia a ficha quando ela muda, continua intacto no produto.
 */
export function seedMlFicha(raw: unknown): MlFicha {
  const out: MlFicha = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as { value_id?: unknown; value_name?: unknown };
    const entry: MlFichaValue = {};
    if (typeof e.value_id === "string" && e.value_id.trim()) {
      entry.value_id = e.value_id;
    }
    if (typeof e.value_name === "string" && e.value_name.trim()) {
      entry.value_name = e.value_name;
    }
    if (entry.value_id || entry.value_name) out[id] = entry;
  }
  return out;
}

const temValor = (v: MlFichaValue | null | undefined): v is MlFichaValue =>
  !!v && (!!v.value_id || !!v.value_name);

const mesmoValor = (a: MlFichaValue, b: MlFichaValue): boolean =>
  (a.value_id ?? "") === (b.value_id ?? "") &&
  (a.value_name ?? "") === (b.value_name ?? "");

/**
 * O que a pessoa MUDOU em relação à ficha do produto: valores novos ou
 * alterados, e `null` para o campo que o produto tinha e ela apagou.
 * `undefined` quando nada mudou (nada vai ao servidor — como antes).
 */
export function diffMlFicha(
  seed: MlFicha,
  current: MlFicha | null | undefined,
): Record<string, MlFichaValue | null> | undefined {
  const atual = current ?? {};
  const out: Record<string, MlFichaValue | null> = {};
  for (const [id, v] of Object.entries(atual)) {
    if (!temValor(v)) continue;
    const antes = seed[id];
    if (temValor(antes) && mesmoValor(antes, v)) continue;
    out[id] = v;
  }
  for (const [id, antes] of Object.entries(seed)) {
    if (temValor(antes) && !temValor(atual[id])) out[id] = null;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Mesma ficha? (independe da ordem das chaves) */
export function sameMlFicha(
  a: MlFicha | null | undefined,
  b: MlFicha | null | undefined,
): boolean {
  return diffMlFicha(seedMlFicha(a), seedMlFicha(b)) === undefined;
}
