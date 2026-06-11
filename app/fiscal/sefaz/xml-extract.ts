/**
 * Helpers leves para extrair valores de XMLs de retorno da SEFAZ.
 *
 * Usamos regex em vez de um parser XML completo porque:
 *   - SEFAZ retorna tags com namespace default (sem prefixo no elemento), o
 *     que torna `<cStat>107</cStat>` localizável diretamente.
 *   - Strings de resposta são pequenas (poucos KB), regex é suficiente.
 *   - Evitamos dependência extra (fast-xml-parser) por enquanto.
 *
 * Quando o parser regex deixar de ser suficiente (XMLs maiores, namespaces
 * aninhados em respostas de RecepcaoEvento4 com múltiplos eventos), iremos
 * para fast-xml-parser. Decisão revisada em F-D.
 */

/**
 * Extrai o texto entre `<tag>` e `</tag>` (não-greedy). Devolve null se ausente.
 *
 * Aceita opcionalmente um prefixo de namespace via `tagPattern`, mas o padrão
 * é tag sem prefixo (caso comum no payload de dados da SEFAZ).
 */
export function extractTagValue(xml: string, tag: string): string | null {
  const re = new RegExp(`<${escapeRegex(tag)}>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`);
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Extrai o texto da primeira ocorrência da tag, ignorando prefixo de namespace.
 * Ex.: `<nfe:cStat>107</nfe:cStat>` ou `<cStat>107</cStat>` → "107".
 */
export function extractTagValueNs(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${escapeRegex(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${escapeRegex(tag)}>`,
  );
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

export function extractIntValue(xml: string, tag: string): number | null {
  const v = extractTagValueNs(xml, tag);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function extractDateValue(xml: string, tag: string): Date | null {
  const v = extractTagValueNs(xml, tag);
  if (v === null) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
