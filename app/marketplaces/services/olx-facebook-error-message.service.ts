/**
 * Tradução dos erros de OLX e Facebook para uma mensagem acionável.
 *
 * Por que existe: as duas APIs devolvem vocabulário cru que chega inteiro ao
 * card do anúncio. O operador via coisas como
 *
 *   OLX      → "OLX recusou o import: statusCode -4"
 *   Facebook → `Facebook rejeitou o item: [{"message":"Invalid parameter",…}]`
 *
 * e não tinha como saber o que corrigir. Espelha o papel do
 * `ml-error-message.service.ts` no Mercado Livre.
 *
 * Conservador por construção: sem um padrão reconhecido devolve `null` e o
 * caller mantém a mensagem atual — nunca inventa diagnóstico.
 */

interface Regra {
  re: RegExp;
  msg: string;
}

// Vocabulário da OLX. Os enums vêm do autoupload e estão catalogados em
// listing-removal.helpers.ts (classifyOlxRemoveError).
const REGRAS_OLX: Regra[] = [
  {
    re: /refused_suspect_price|suspect_price/i,
    msg: "A OLX considerou o preço suspeito para esta categoria. Revise o valor do anúncio.",
  },
  {
    re: /error_image_too_small|image_too_small/i,
    msg: "Alguma foto está abaixo do tamanho mínimo exigido pela OLX. Suba imagens maiores.",
  },
  {
    re: /not_enough_ad_slots/i,
    msg: "A conta da OLX não tem mais vagas de anúncio no plano contratado. Libere um anúncio ou amplie o plano.",
  },
  {
    re: /refused_duplicated|duplicated/i,
    msg: "A OLX identificou este anúncio como duplicado de outro já publicado na conta.",
  },
  {
    re: /error_downloading_image|error_uploading_image/i,
    msg: "A OLX não conseguiu baixar as fotos do anúncio. Costuma ser temporário — tente novamente.",
  },
  {
    re: /ad_not_found|does not exist|inexist/i,
    msg: "O anúncio não existe mais na OLX (já foi removido por lá).",
  },
  {
    re: /statusCode\s*-4\b/i,
    msg: "A OLX recusou o anúncio por validação de conteúdo. Revise título, descrição, preço e categoria.",
  },
  {
    re: /statusCode\s*-6\b/i,
    msg: "A conta da OLX não tem permissão para esta operação. Verifique o plano e a autorização do integrador.",
  },
  {
    re: /statusCode\s*-1\b/i,
    msg: "A OLX está instável no momento. O anúncio será reenviado automaticamente.",
  },
];

// Vocabulário da Graph API (Meta). O código numérico não chega até aqui —
// FacebookApiService.formatError monta só a mensagem —, então casamos por texto.
const REGRAS_FACEBOOK: Regra[] = [
  {
    re: /invalid oauth access token|error validating access token|session has expired|oauthexception/i,
    msg: "O token do Facebook expirou ou foi revogado. Reconecte a conta em Integrações.",
  },
  {
    re: /does not exist, cannot be loaded due to missing permission/i,
    msg: "O catálogo do Facebook não existe ou a conta não tem permissão sobre ele. Confira o catálogo configurado na conta.",
  },
  {
    re: /missing.*required.*(image|picture)|image_url/i,
    msg: "O item do Facebook precisa de ao menos uma imagem válida e acessível publicamente.",
  },
  {
    re: /invalid parameter/i,
    msg: "A Meta recusou algum campo do item. Revise título, descrição, preço, categoria e o link do produto.",
  },
  {
    re: /price/i,
    msg: "A Meta recusou o preço do item. Confira o valor e a moeda configurada no catálogo.",
  },
  {
    re: /rate limit|too many calls|request limit reached/i,
    msg: "Limite de chamadas da Meta atingido. O anúncio será reenviado automaticamente.",
  },
];

/**
 * Devolve uma mensagem em português para o erro, ou `null` quando não
 * reconhece o padrão (o caller então mantém o texto original).
 */
export function humanizeMarketplaceError(
  platform: string | null | undefined,
  rawMessage: string | null | undefined,
): string | null {
  if (!rawMessage) return null;
  const regras =
    platform === "OLX"
      ? REGRAS_OLX
      : platform === "FACEBOOK"
        ? REGRAS_FACEBOOK
        : null;
  if (!regras) return null;

  for (const { re, msg } of regras) {
    if (re.test(rawMessage)) return msg;
  }
  return null;
}

/**
 * Mensagem final para exibição: a tradução quando existe, senão o original.
 * Mantém o texto cru no fim entre parênteses para não perder o diagnóstico
 * técnico de quem for investigar.
 */
export function formatMarketplaceError(
  platform: string | null | undefined,
  rawMessage: string | null | undefined,
): string {
  const original = (rawMessage ?? "").trim();
  const humana = humanizeMarketplaceError(platform, original);
  if (!humana) return original;
  return original ? `${humana} (detalhe: ${original})` : humana;
}
