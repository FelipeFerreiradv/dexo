/**
 * Texto da descrição que o Mercado Livre aceita em `plain_text`.
 *
 * O ML recusa emoji na descrição ("The description must be in plain text",
 * cause 398 `item.description.type.invalid` — doc "Descrição de produtos"). Na
 * prática o anúncio era criado com a descrição VAZIA e a Dexo registrava
 * sucesso: medido em 23/09/2026, 12 de 12 anúncios cuja descrição tinha "⚠️"
 * ou "🚗" estavam sem descrição no ML (inclusive de 18/09), ~300 anúncios
 * ativos no total. Caso reportado: SKU 7167 da Portal Eco Peças, com o bloco
 * "⚠️ ATENÇÃO E OBSERVAÇÕES IMPORTANTES" na descrição padrão.
 *
 * Dois níveis, para não mexer no que já funciona:
 * - "basico": tira só o que se provou recusado — emoji fora do plano básico
 *   (🚗, 😀…) e os caracteres que montam emoji (seletor de variação U+FE0F do
 *   "⚠️", junção U+200D, tecla U+20E3). Descrição sem nada disso volta idêntica.
 * - "estrito": além disso, os símbolos pictográficos do plano básico a partir
 *   de U+2190 (⚠ ✅ ✔ ❌ ★ ☎ ➡…). Usado só quando o ML recusa ou grava vazio.
 *   ©, ®, ™ e a pontuação comum ficam (estão abaixo de U+2190).
 */

export type DescriptionSanitizeMode = "basico" | "estrito";

const PICTOGRAFICO = /\p{Extended_Pictographic}/u;

function descartar(cp: number, ch: string, mode: DescriptionSanitizeMode): boolean {
  if (cp > 0xffff) return true; // emoji e demais fora do plano básico
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // seletores de variação
  if (cp === 0x200d || cp === 0x20e3) return true; // junção / tecla
  return mode === "estrito" && cp >= 0x2190 && PICTOGRAFICO.test(ch);
}

export function sanitizeMLDescription(
  text: string | null | undefined,
  mode: DescriptionSanitizeMode = "basico",
): { text: string; removed: number } {
  const original = text ?? "";
  let removed = 0;
  let out = "";
  for (const ch of original) {
    const cp = ch.codePointAt(0) ?? 0;
    if (descartar(cp, ch, mode)) {
      removed += 1;
      continue;
    }
    out += ch;
  }
  if (removed === 0) return { text: original, removed: 0 };
  // Arruma o espaço que o símbolo deixou ("⚠️ ATENÇÃO" → "ATENÇÃO"): só onde
  // algo saiu, a formatação do resto não muda.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+/gm, "")
    .replace(/[ \t]+$/gm, "");
  return { text: out, removed };
}

/**
 * O texto tem símbolo/emoji (qualquer caractere a partir de U+2190)? Só então
 * vale conferir o que o ML gravou — descrição comum não ganha chamada a mais.
 */
export function descriptionHasSymbols(text: string | null | undefined): boolean {
  for (const ch of text ?? "") {
    if ((ch.codePointAt(0) ?? 0) >= 0x2190) return true;
  }
  return false;
}

/** Erro do ML para caractere não aceito na descrição (cause 398). */
export function isInvalidDescriptionCharError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    msg.includes("item.description.type.invalid") ||
    msg.includes("must be in plain text")
  );
}
