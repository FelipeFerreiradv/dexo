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
 * Testa se um codepoint é desenhável pelas StandardFonts (WinAnsiEncoding).
 *
 * O encoder do pdf-lib LANÇA — não substitui — para três faixas que um
 * `code <= 0xff` ingênuo deixaria passar (verificado em runtime contra o
 * pdf-lib 1.17.1 deste worktree, varrendo 0x00..0xFF):
 *   • C0, 0x00–0x1F  (inclui \n, \t e \r)
 *   • DEL, 0x7F
 *   • C1, 0x80–0x9F  (os "buracos" do CP-1252)
 *
 * Os símbolos tipográficos do CP-1252 (€ … — • š …) são codepoints ACIMA de
 * 0xFF e entram por `WINANSI_EXTRAS`; não confundir com a faixa 0x80–0x9F.
 */
function isWinAnsiDrawable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
  return code <= 0xff || WINANSI_EXTRAS.includes(ch);
}

/**
 * Torna texto livre do usuário seguro para o pdf-lib.
 *
 * Caractere não-desenhável vira "?" (visível, sinalizando perda) e caractere
 * de CONTROLE é removido (invisível por natureza — marcá-lo com "?" só sujaria
 * o documento). `\t` vira espaço.
 *
 * ⚠️ `\n` é PRESERVADO: esta função é usada em conjunto com `wrapTextLines`,
 * que quebra parágrafos nos `\n` do usuário (é assim que o bloco de
 * Informações Complementares fica multilinha). Logo o resultado ainda NÃO pode
 * ir direto para `drawText` — passe por `wrapTextLines` antes, ou use
 * `toWinAnsiSafeLine` para campos de uma linha só.
 *
 * IMPORTANTE: sanear ANTES de qualquer medição. `PDFFont.widthOfTextAtSize()`
 * lança exatamente como `drawText`, então medir texto cru (para quebra de linha
 * ou truncamento) derruba a geração antes de desenhar qualquer coisa.
 */
export function toWinAnsiSafe(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (ch === "\n") {
      out += ch;
      continue;
    }
    if (ch === "\t") {
      out += " ";
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    // Controle (C0/DEL/C1): remove em silêncio, não tem representação visual.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += isWinAnsiDrawable(ch) ? ch : "?";
  }
  return out;
}

/**
 * Igual a `toWinAnsiSafe`, mas para campos de UMA linha (razão social,
 * descrição do item, endereço): as quebras viram espaço, então o resultado
 * pode ir direto para `drawText`/`widthOfTextAtSize` sem intermediários.
 */
export function toWinAnsiSafeLine(s: string): string {
  return toWinAnsiSafe(s).replace(/\n/g, " ").replace(/ {2,}/g, " ").trim();
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

/**
 * Formata um número no padrão monetário brasileiro, SEM o prefixo "R$":
 *   1234.5 → "1.234,50"   |   50 → "50,00"   |   0/null → "0,00"
 *
 * Uso exclusivo das EXIBIÇÕES do DANFE (PDF). NÃO usar no XML da NF-e: o leiaute
 * SEFAZ exige ponto como separador decimal (ex.: "50.00"); vírgula faria a nota
 * ser rejeitada. Caracteres "." e "," são WinAnsi-safe (pdf-lib desenha ok).
 */
export function formatBRLNumber(value: number | null | undefined): string {
  const n = Number(value) || 0;
  // Implementação manual (não depende de ICU/Intl, que pode faltar no Node do
  // servidor): 2 casas, ponto como separador de milhar, vírgula no decimal.
  const [intPart, decPart] = Math.abs(n).toFixed(2).split(".");
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${withThousands},${decPart}`;
}
