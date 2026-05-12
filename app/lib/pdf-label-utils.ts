import type { PDFFont } from "pdf-lib";

/**
 * Quebra um texto em múltiplas linhas respeitando largura máxima medida
 * pela fonte do PDF. Trunca com "..." se ainda exceder após atingir
 * `maxLines`. Comportamento idêntico ao usado em
 * app/produtos/lib/labels-pdf.ts (extraído nesta fase para reuso).
 */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const sanitized = text.replace(/\s+/g, " ").trim();
  if (!sanitized) return [];

  const words = sanitized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(next, size);
    if (width <= maxWidth) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
    } else {
      // Word longer than max width – split hard
      lines.push(word);
    }
    current = word;

    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  // Truncate last line if still too long
  if (lines.length === maxLines) {
    const last = lines[lines.length - 1];
    let truncated = last;
    while (
      font.widthOfTextAtSize(truncated, size) > maxWidth &&
      truncated.length > 3
    ) {
      truncated = `${truncated.slice(0, -2)}...`;
    }
    lines[lines.length - 1] = truncated;
  }

  return lines;
}
