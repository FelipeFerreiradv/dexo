/**
 * Helpers puros do DANFE (sem pdf-lib / sem I/O), testáveis isoladamente.
 */

export interface CstCsosn {
  /** Rótulo da coluna conforme o regime: "CSOSN" (Simples) ou "CST" (normal). */
  label: string;
  /** Código tributário do ICMS exibido. */
  value: string;
}

/**
 * Resolve o código tributário do ICMS para exibição no DANFE.
 *
 * No Simples Nacional usa-se CSOSN (default 102 — "tributada sem permissão de
 * crédito"); no regime normal usa-se CST (default 00). É o mesmo default que o
 * gerador de XML aplica na emissão (`item.cstIcms ?? (SIMPLES ? "102" : "00")`),
 * então o valor exibido reflete o que foi efetivamente enviado quando o item
 * não traz um CST/CSOSN específico.
 */
export function resolveCstCsosn(
  regime: string | null | undefined,
  cstIcms?: string | null,
): CstCsosn {
  const isSimples = regime === "SIMPLES";
  const value =
    cstIcms && cstIcms.trim() ? cstIcms.trim() : isSimples ? "102" : "00";
  return { label: isSimples ? "CSOSN" : "CST", value };
}

// Extras do CP-1252 acima de 0xFF que as StandardFonts do pdf-lib aceitam.
const WINANSI_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ''“”•–—˜™š›œžŸ";

/**
 * Substitui caracteres fora do WinAnsi (encoding das StandardFonts do
 * pdf-lib) por "?", para que texto livre do usuário (ex.: emoji) não derrube
 * a geração do DANFE com "cannot encode" do pdf-lib.
 */
export function toWinAnsiSafe(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0xff || WINANSI_EXTRAS.includes(ch) ? ch : "?";
  }
  return out;
}

/**
 * Quebra texto em linhas que caibam em `maxWidth` (medida via `measure`),
 * preservando os `\n` do usuário. Palavras maiores que a linha são fatiadas.
 */
export function wrapTextLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      let rest = word;
      while (measure(rest) > maxWidth && rest.length > 1) {
        let i = 1;
        while (i < rest.length && measure(rest.slice(0, i + 1)) <= maxWidth) {
          i++;
        }
        lines.push(rest.slice(0, i));
        rest = rest.slice(i);
      }
      current = rest;
    }
    lines.push(current);
  }
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
