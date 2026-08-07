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
import {
  ML_SAFE_MAX_DIM_CM,
  ML_SAFE_MAX_SUM_CM,
  ML_SAFE_MAX_WEIGHT_KG,
} from "../../lib/ml-measurements";
import type { AiSource } from "../core/types";

export const CANAIS = ["mercado_livre", "shopee", "magalu"] as const;
export type Canal = (typeof CANAIS)[number];

export const NOME_DO_CANAL: Record<Canal, string> = {
  mercado_livre: "Mercado Livre",
  shopee: "Shopee",
  magalu: "Magalu",
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
  }
}

/** As regras de DESCRIÇÃO do canal. */
export function regrasDeDescricao(canal: Canal): RegraDeCanal[] {
  const comum: RegraDeCanal[] = [
    {
      rule: "Descrição: sem telefone, WhatsApp, e-mail ou link externo",
      detalhe:
        "Marketplace pune anúncio que tenta levar o comprador para fora da plataforma. Isso derruba anúncio e, repetido, derruba conta.",
    },
  ];

  if (canal === "shopee") {
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
  }

  if (canal === "magalu") {
    return [
      ...comum,
      {
        rule: `Descrição do Magalu: ${MAGALU_CONSTANTS.DESCRIPTION_MAX_LENGTH} caracteres`,
        detalhe: `Limite marcado como PROVISÓRIO no código do Dexo — confirme na sua conta.`,
      },
    ];
  }

  return [
    ...comum,
    {
      rule: "Descrição do Mercado Livre: texto puro",
      detalhe:
        "A descrição vai como texto simples. Formatação, HTML e emoji não sobrevivem à publicação.",
    },
  ];
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
