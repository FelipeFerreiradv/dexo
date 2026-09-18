/**
 * Numeração V2 — extração do DigestValue da assinatura do `infNFe`.
 *
 * Por que existe: a consulta por chave (NfeConsultaProtocolo4) devolve
 * `protNFe/infProt/digVal`, que é o DigestValue da NF-e que a SEFAZ autorizou.
 * Guardar o DigestValue de CADA tentativa antes de transmitir permite provar a
 * posse numa duplicidade (204/539): mesma chave + mesmo digest = a autorização
 * é desta tentativa; digest diferente = conteúdo alheio (anomalia).
 *
 * Regra: só vale o `<DigestValue>` da `<Reference>` cujo `URI` aponta para o
 * `Id` do `infNFe` (`#NFe<chave>`). Qualquer outra Reference (evento, infInut,
 * assinaturas de outros nós) é ignorada. Sem `infNFe` com `Id`, ou sem a
 * Reference correspondente, devolve `null` — nunca inventa.
 *
 * Módulo PURO (sem imports, sem node:*) — regex sobre a string assinada, que
 * não é re-serializada (re-canonizar quebraria a assinatura).
 */

const INF_NFE_ID = /<(?:[\w-]+:)?infNFe\b[^>]*?\sId\s*=\s*(["'])([^"']+)\1/;

const REFERENCE =
  /<(?:[\w-]+:)?Reference\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Reference>/g;

const URI_ATTR = /\sURI\s*=\s*(["'])([^"']*)\1/;

const DIGEST_VALUE =
  /<(?:[\w-]+:)?DigestValue(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?DigestValue>/;

export function extrairDigestValue(signedXml: string): string | null {
  if (typeof signedXml !== "string" || signedXml.length === 0) return null;

  const idMatch = INF_NFE_ID.exec(signedXml);
  if (!idMatch) return null;
  const alvo = `#${idMatch[2].trim()}`;

  // RegExp global é stateful: instância local por chamada (função pura).
  const referencias = new RegExp(REFERENCE.source, "g");
  let ref: RegExpExecArray | null;
  while ((ref = referencias.exec(signedXml)) !== null) {
    const uri = URI_ATTR.exec(ref[1]);
    if (!uri || uri[2].trim() !== alvo) continue;
    const digest = DIGEST_VALUE.exec(ref[2]);
    if (!digest) return null;
    // Base64 não tem espaço significativo (alguns assinadores quebram linha).
    const valor = digest[1].replace(/\s+/g, "");
    return valor.length > 0 ? valor : null;
  }
  return null;
}
