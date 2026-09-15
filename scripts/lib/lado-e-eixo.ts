/**
 * LADO E EIXO SAO EXCLUDENTES — e o Jaccard nao enxerga isso.
 * ===========================================================
 *
 * `areTitlesSimilar` (limiar 0,4) compara conjuntos de tokens. Num desmanche,
 * porem, o token que decide a IDENTIDADE da peca costuma ser um so:
 *
 *   "Pinca Freio Dianteira Esquerda Gol G5"   x   "Pinca Freio Dianteira Direita Gol G5"
 *      -> semelhanca 0,82  =>  "titulo BATE"  =>  aprovado
 *
 * Sao duas pecas fisicas diferentes. O mesmo vale para o eixo:
 *
 *   "Alca Teto Traseiro Jetta 2011..."        x   "Alca Teto Dianteiro Jetta 2011..."
 *      -> semelhanca 0,83  =>  aprovado
 *
 * ⚠️⚠️ QUANTO ISSO ESCONDEU (medido em 15/09/2026, sobre os caches de anuncio
 * de 9 clientes ja varridos): **879 vinculos** tem anuncio e produto com lado
 * ou eixo OPOSTOS. Destes, **542 tem semelhanca >= 0,4** — ou seja, TODAS as
 * varreduras que rodei reportaram esses 542 como "titulo bate". A deteccao de
 * divergencia era cega justamente onde o desmanche mais erra.
 *
 * Distribuicao: Revive 278 · Tijuco Preto 176 · Motors Mania 140 · 777 130 ·
 * Agua Rasa 55 · Jotabe 44 · MK2 35 · Platinum 20 · Gastura 1.
 *
 * REGRA DE DECISAO
 * So acusa quando os DOIS titulos declaram lado (ou eixo) e eles DIVERGEM.
 * Titulo omisso nao acusa nada: silencio nao e evidencia. Isso mantem o falso
 * positivo em zero no caso comum ("Farol Esquerdo Gol" x "Farol Gol").
 *
 * ⚠️ A BORDA `\b` E OBRIGATORIA nas formas compactas: sem ela, o "le" de
 * "Lente Do Farol" casaria como lado esquerdo.
 */

const semAcento = (s: string): string =>
  (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export type Lado = "E" | "D";
export type Eixo = "DIANT" | "TRAS";

/** Lado declarado pelo titulo, ou `null` quando omisso/ambiguo. */
export function ladoDe(titulo: string): Lado | null {
  const s = semAcento(titulo);
  // Alem de "esquerda/esquerdo", as formas compactas usadas no ramo:
  // l/e (lado esq), t/e (traseira esq), d/e (dianteira esq) — e as de direita.
  const e = /\besquerd[ao]\b/.test(s) || /\b[ltd][/.\s-]?e\b/.test(s);
  const d = /\bdireit[ao]\b/.test(s) || /\b[ltd][/.\s-]?d\b/.test(s);
  if (e && !d) return "E";
  if (d && !e) return "D";
  return null;
}

/** Eixo declarado pelo titulo, ou `null` quando omisso/ambiguo. */
export function eixoDe(titulo: string): Eixo | null {
  const s = semAcento(titulo);
  const di = /\bdianteir[ao]s?\b/.test(s);
  const tr = /\btraseir[ao]s?\b/.test(s);
  if (di && !tr) return "DIANT";
  if (tr && !di) return "TRAS";
  return null;
}

/**
 * `true` quando os dois titulos declaram lado ou eixo e eles se contradizem.
 * Use SEMPRE junto de `areTitlesSimilar`, nunca no lugar dela: esta funcao
 * responde "sao peças opostas?", nao "sao a mesma peça?".
 */
export function ladoOuEixoOposto(a: string, b: string): boolean {
  const la = ladoDe(a);
  const lb = ladoDe(b);
  if (la && lb && la !== lb) return true;
  const ea = eixoDe(a);
  const eb = eixoDe(b);
  if (ea && eb && ea !== eb) return true;
  return false;
}

/** Texto curto para relatorio: "lado ExD", "eixo DIANTxTRAS", ou "". */
export function motivoOposicao(a: string, b: string): string {
  const partes: string[] = [];
  const la = ladoDe(a);
  const lb = ladoDe(b);
  if (la && lb && la !== lb) partes.push(`lado ${la}x${lb}`);
  const ea = eixoDe(a);
  const eb = eixoDe(b);
  if (ea && eb && ea !== eb) partes.push(`eixo ${ea}x${eb}`);
  return partes.join(" + ");
}
