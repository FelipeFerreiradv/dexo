// Fonte 4 da cadeia: as REGRAS determinísticas do sistema.
//
// Uma distinção que vale o arquivo inteiro: regra de canal NÃO é uma fonte
// alternativa, é uma RESTRIÇÃO. Não faz sentido "o catálogo respondeu, então
// não preciso do limite de 60 caracteres do ML" — o limite vale sempre, venha
// o texto de onde vier. Por isso as tools de título e descrição anexam estas
// regras FORA da cadeia, junto de qualquer resposta.
//
// Tudo aqui é verificável no código. Os limites importados vêm das constantes
// reais; o único número copiado é o da Shopee, que vive inline num método
// privado — e `ai-advisory-rules.spec.ts` falha se ele mudar lá e não aqui.
//
// Por que isso importa na prática: o Dexo não avisa o lojista quando corta. Ele
// publica um título de 60 caracteres a partir de um nome de 90 e ninguém vê o
// que ficou de fora até abrir o anúncio no marketplace.

import { MAGALU_CONSTANTS } from "../../marketplaces/magalu/magalu-constants";
import { ML_TITLE_MAX_LEN } from "../../marketplaces/lib/ml-title";
import { OLX_CONSTANTS } from "../../marketplaces/olx/olx-constants";
import { FACEBOOK_CONSTANTS } from "../../marketplaces/facebook/facebook-constants";
import {
  ML_SAFE_MAX_DIM_CM,
  ML_SAFE_MAX_SUM_CM,
  ML_SAFE_MAX_WEIGHT_KG,
} from "../../lib/ml-measurements";
import type { AiSource } from "../core/types";

export const CANAIS = [
  "mercado_livre",
  "shopee",
  "magalu",
  "olx",
  "facebook",
] as const;
export type Canal = (typeof CANAIS)[number];

export const NOME_DO_CANAL: Record<Canal, string> = {
  mercado_livre: "Mercado Livre",
  shopee: "Shopee",
  magalu: "Magalu",
  olx: "OLX",
  facebook: "Facebook",
};

/**
 * Teto de título da Shopee.
 *
 * ⚠️ CÓPIA CONSCIENTE. O número vive inline em `ListingUseCase.buildShopeeTitle`
 * (listing.usercase.ts:3438), que é um método PRIVADO — não dá para importar
 * sem mexer num arquivo fora do escopo desta entrega. `ai-advisory-rules.spec.ts`
 * lê aquele arquivo e falha se os dois números divergirem, então a cópia não
 * consegue envelhecer em silêncio.
 */
export const SHOPEE_TITLE_MAX_LEN = 120;

/**
 * Tetos de descrição da Shopee — mesma situação do título: são `private static`
 * em `ListingUseCase` (SHOPEE_MAX_DESCRIPTION / SHOPEE_DESC_SAFE_LIMIT). O
 * spec de regras pina os dois contra o arquivo real.
 */
export const SHOPEE_DESCRIPTION_MAX_LEN = 5000;
export const SHOPEE_DESCRIPTION_SAFE_LEN = 4900;

export interface RegraDeCanal {
  /** Texto curto, escrito para o LOJISTA. Vai virar `AiSource.rule`. */
  rule: string;
  /** Detalhe que o modelo repassa. */
  detalhe: string;
}

/**
 * As regras de TÍTULO do canal — o que o sistema faz com o nome da peça na
 * hora de publicar.
 */
export function regrasDeTitulo(canal: Canal): RegraDeCanal[] {
  switch (canal) {
    case "mercado_livre":
      return [
        {
          rule: `Título do Mercado Livre: ${ML_TITLE_MAX_LEN} caracteres`,
          detalhe: `O Dexo corta em ${ML_TITLE_MAX_LEN} caracteres, sem avisar. O que passar disso não é publicado.`,
        },
        {
          rule: "Título do Mercado Livre: só letra, número, espaço e hífen",
          detalhe:
            'Barra, parêntese, asterisco, "+" e pontuação em geral viram espaço na publicação. "Farol D/E" é publicado como "Farol D E".',
        },
        {
          rule: "Título do Mercado Livre: sem palavra de promoção",
          detalhe:
            'O ML recusa ou despriorija anúncio com "promoção", "frete grátis", "oferta", "o melhor" e afins no título. Título é o que a peça É.',
        },
      ];
    case "shopee":
      return [
        {
          rule: `Título da Shopee: ${SHOPEE_TITLE_MAX_LEN} caracteres`,
          detalhe: `O Dexo corta em ${SHOPEE_TITLE_MAX_LEN} caracteres.`,
        },
        {
          rule: "Título da Shopee: marca, modelo, ano e part number já são acrescentados pelo sistema",
          detalhe:
            'Na publicação o Dexo monta o título como "nome - marca - modelo - ano - versão - PN: número". Repetir esses dados no nome da peça só gasta os caracteres duas vezes.',
        },
      ];
    case "magalu":
      return [
        {
          rule: `Título do Magalu: ${MAGALU_CONSTANTS.TITLE_MAX_LENGTH} caracteres`,
          detalhe: `O Dexo corta em ${MAGALU_CONSTANTS.TITLE_MAX_LENGTH} caracteres. Este limite está marcado como PROVISÓRIO no código do Dexo (magalu-constants.ts) — confirme na sua conta antes de contar com ele.`,
        },
      ];
    case "olx":
      return [
        {
          rule: `Título da OLX: ${OLX_CONSTANTS.TITLE_MAX_LENGTH} caracteres`,
          detalhe: `O anúncio da OLX chama isso de "Subject". O Dexo corta em ${OLX_CONSTANTS.TITLE_MAX_LENGTH} caracteres, sem avisar.`,
        },
        {
          // O oposto do conselho da Shopee, e é o ponto mais importante deste
          // canal: `olx-payload-builder.service.ts:32-36` manda
          // `product.name` CRU. Não existe montagem de título na OLX.
          rule: "Título da OLX: o sistema NÃO acrescenta marca, modelo nem ano",
          detalhe:
            "Ao contrário da Shopee, na OLX o Dexo publica o nome da peça exatamente como está cadastrado. O que não estiver no nome não aparece no anúncio — marca, modelo e ano precisam estar escritos ali.",
        },
      ];
    case "facebook":
      return [
        {
          rule: `Título do Facebook: ${FACEBOOK_CONSTANTS.TITLE_MAX_LENGTH} caracteres`,
          detalhe: `É o campo "name" do item de catálogo. O Dexo corta em ${FACEBOOK_CONSTANTS.TITLE_MAX_LENGTH} caracteres.`,
        },
        {
          rule: "Título do Facebook: o sistema NÃO acrescenta marca, modelo nem ano",
          detalhe:
            "Como na OLX, o nome da peça vai cru para o catálogo. A marca, quando cadastrada na peça, vai num campo próprio do item — mas modelo e ano só aparecem se estiverem no nome.",
        },
      ];
  }
}

/**
 * As regras de DESCRIÇÃO do canal.
 *
 * ⭐ É um `switch` EXAUSTIVO, sem `default`, e isso é a trava — não é estilo.
 * Até a entrada da OLX e do Facebook esta função terminava num `return` solto
 * com as regras do Mercado Livre, então um canal novo caía nele em silêncio e o
 * lojista ouvia "Descrição do Mercado Livre: texto puro" sobre um anúncio da
 * OLX. O compilador não pega isso num `if` encadeado; num `switch` sem
 * `default` sobre uma união fechada, pega.
 */
export function regrasDeDescricao(canal: Canal): RegraDeCanal[] {
  const comum: RegraDeCanal[] = [
    {
      rule: "Descrição: sem telefone, WhatsApp, e-mail ou link externo",
      detalhe:
        "Marketplace pune anúncio que tenta levar o comprador para fora da plataforma. Isso derruba anúncio e, repetido, derruba conta.",
    },
  ];

  switch (canal) {
    case "shopee":
      return [
        ...comum,
        {
          rule: "Descrição da Shopee: ficha técnica e SKU já são acrescentados pelo sistema",
          detalhe:
            'Na publicação o Dexo anexa um bloco "Detalhes Técnicos" com marca, modelo, ano, versão, part number, qualidade e localização, mais a linha do SKU. Não repita isso no texto livre.',
        },
        {
          rule: `Descrição da Shopee: até ${SHOPEE_DESCRIPTION_MAX_LEN} caracteres`,
          detalhe: `A Shopee aceita de 10 a ${SHOPEE_DESCRIPTION_MAX_LEN} caracteres; o Dexo trunca com folga em ${SHOPEE_DESCRIPTION_SAFE_LEN} para caber o bloco técnico.`,
        },
      ];

    case "magalu":
      return [
        ...comum,
        {
          rule: `Descrição do Magalu: ${MAGALU_CONSTANTS.DESCRIPTION_MAX_LENGTH} caracteres`,
          detalhe: `Limite marcado como PROVISÓRIO no código do Dexo — confirme na sua conta.`,
        },
      ];

    case "olx":
      return [
        // Na OLX o contato do vendedor é campo PRÓPRIO do anúncio (`Phone`,
        // vindo da conta — olx-constants.ts:resolveOlxSellerContact), então a
        // regra comum vira um conselho diferente: não é só política, é
        // repetição inútil.
        {
          rule: "Descrição da OLX: o telefone já vai em campo próprio",
          detalhe:
            "O contato do vendedor é preenchido na conexão da OLX e sai no anúncio automaticamente. Repetir telefone, WhatsApp ou link no texto não acrescenta nada e é o tipo de coisa que a OLX derruba.",
        },
        {
          rule: `Descrição da OLX: ${OLX_CONSTANTS.DESCRIPTION_MAX_LENGTH} caracteres`,
          detalhe: `O anúncio da OLX chama isso de "Body". O Dexo corta em ${OLX_CONSTANTS.DESCRIPTION_MAX_LENGTH} caracteres.`,
        },
        {
          // olx-payload-builder.service.ts:37-41 —
          // `product.description ?? product.name`.
          rule: "Descrição da OLX: peça sem descrição publica o NOME no lugar",
          detalhe:
            "A OLX exige um corpo de anúncio. Se a peça não tiver descrição cadastrada, o Dexo manda o nome dela — o anúncio sai com o título repetido no corpo. Não é erro do sistema, é a peça sem descrição.",
        },
      ];

    case "facebook":
      return [
        ...comum,
        {
          rule: `Descrição do Facebook: ${FACEBOOK_CONSTANTS.DESCRIPTION_MAX_LENGTH} caracteres`,
          detalhe: `É o campo "description" do item de catálogo. O Dexo corta em ${FACEBOOK_CONSTANTS.DESCRIPTION_MAX_LENGTH} caracteres.`,
        },
        {
          // facebook-payload-builder.service.ts:40-42 e :49 — mesmo fallback
          // da OLX, com um segundo degrau ("-") para nunca mandar vazio.
          rule: "Descrição do Facebook: peça sem descrição publica o NOME no lugar",
          detalhe:
            "O item de catálogo não aceita descrição vazia. Sem descrição cadastrada, o Dexo manda o nome da peça.",
        },
      ];

    case "mercado_livre":
      return [
        ...comum,
        {
          rule: "Descrição do Mercado Livre: texto puro",
          detalhe:
            "A descrição vai como texto simples. Formatação, HTML e emoji não sobrevivem à publicação.",
        },
      ];
  }
}

/**
 * As regras de PREÇO do canal.
 *
 * Lista VAZIA é resposta legítima e é o caso de três dos cinco canais: no
 * Mercado Livre, na Shopee e no Magalu o preço vai como está e não há nada a
 * avisar. Só a OLX transforma o número.
 *
 * Existe porque o Bitz altera preço (`produto.preco`) e, sem isto, ele diria
 * "o preço passou a ser R$ 180,50" para uma peça anunciada na OLX — onde o
 * anúncio vai mostrar R$ 181. Um número certo no Dexo e outro no anúncio é
 * exatamente o que o lojista chama de "o sistema mudou meu preço sozinho".
 */
export function regrasDePreco(canal: Canal): RegraDeCanal[] {
  switch (canal) {
    case "olx":
      return [
        {
          // olx-payload-builder.service.ts:96-99 — `Math.round`, não trunca.
          rule: "Preço da OLX: só número inteiro",
          detalhe:
            "O anúncio da OLX não aceita centavos. O Dexo ARREDONDA na publicação: R$ 180,50 vira R$ 181 e R$ 180,49 vira R$ 180. O preço no Dexo continua com os centavos — quem arredonda é o anúncio.",
        },
      ];
    case "mercado_livre":
    case "shopee":
    case "magalu":
    case "facebook":
      return [];
  }
}

/**
 * Os limites de MEDIDA do Mercado Envios.
 *
 * Não é preciosismo: o comentário de `ml-measurements.ts:278-282` diz que
 * medida acima disso "causa rejeição ou, pior, ban silencioso da conta". É a
 * regra mais cara de errar em toda esta fase.
 */
export const LIMITES_MERCADO_ENVIOS = {
  maiorLadoCm: ML_SAFE_MAX_DIM_CM,
  somaDosLadosCm: ML_SAFE_MAX_SUM_CM,
  pesoKg: ML_SAFE_MAX_WEIGHT_KG,
} as const;

export interface MedidasParaChecar {
  alturaCm?: number | null;
  larguraCm?: number | null;
  comprimentoCm?: number | null;
  pesoKg?: number | null;
}

/**
 * Confere as medidas contra o Mercado Envios. Devolve os problemas em texto,
 * lista vazia quando está tudo dentro.
 */
export function checarMercadoEnvios(m: MedidasParaChecar): string[] {
  const problemas: string[] = [];
  const h = m.alturaCm ?? 0;
  const w = m.larguraCm ?? 0;
  const l = m.comprimentoCm ?? 0;
  const peso = m.pesoKg ?? 0;

  const maior = Math.max(h, w, l);
  if (maior > ML_SAFE_MAX_DIM_CM) {
    problemas.push(
      `o maior lado (${maior} cm) passa do limite de ${ML_SAFE_MAX_DIM_CM} cm do Mercado Envios`,
    );
  }
  if (h + w + l > ML_SAFE_MAX_SUM_CM) {
    problemas.push(
      `a soma dos lados (${h + w + l} cm) passa do limite de ${ML_SAFE_MAX_SUM_CM} cm`,
    );
  }
  if (peso > ML_SAFE_MAX_WEIGHT_KG) {
    problemas.push(
      `o peso (${peso} kg) passa do limite de ${ML_SAFE_MAX_WEIGHT_KG} kg`,
    );
  }
  return problemas;
}

/** Converte uma regra em procedência para o card de fontes. */
export function fonteDeRegra(regra: RegraDeCanal): AiSource {
  return { kind: "regra", rule: regra.rule };
}
