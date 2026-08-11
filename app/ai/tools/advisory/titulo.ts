// Tool consultiva: SUGERIR TÍTULO de anúncio.
//
// Esta e a de descrição são as duas únicas tools desta fase que terminam em
// `estimativa`, e a diferença com preço/medida/compatibilidade é de natureza:
// aqui o texto redigido pelo modelo É a entrega. Não existe "título verdadeiro"
// para o Bitz errar — existe título que respeita o canal e título que não
// respeita. Preço inventado é dado falso; título escrito é trabalho feito.
//
// ⭐ AS REGRAS DO CANAL NÃO SÃO UM DEGRAU DA CADEIA.
// Cadeia é "de onde vem a resposta" e para no primeiro que responde. Limite de
// caracteres não é uma alternativa a exemplos do catálogo — é restrição, e vale
// sobre qualquer resposta. Se as regras fossem um degrau, um catálogo próprio
// cheio faria o modelo nunca saber que o ML corta em 60 caracteres.
//
// A prévia do que seria publicado usa `sanitizeMLTitle`, a MESMA função da
// criação de anúncio. Não é uma simulação parecida: é a função.

import { z } from "zod";

import { sanitizeMLTitle } from "../../../marketplaces/lib/ml-title";
import { OLX_CONSTANTS } from "../../../marketplaces/olx/olx-constants";
import { FACEBOOK_CONSTANTS } from "../../../marketplaces/facebook/facebook-constants";
import {
  CANAIS,
  NOME_DO_CANAL,
  fonteDeRegra,
  regrasDeTitulo,
  type Canal,
} from "../../advisory/channel-rules";
import { buscarPecasParecidas } from "../../advisory/own-catalog";
import { resolverNaOrdem } from "../../advisory/source-chain";
import type { AiSource } from "../../core/types";
import type { AiTool } from "../registry";

/** Quantos títulos do próprio catálogo mostrar como exemplo. */
const MAX_EXEMPLOS = 6;

interface Referencia {
  exemplos: string[];
  comoLer: string;
  estimativa: boolean;
}

/**
 * A prévia do que sairia publicado, quando o canal transforma o texto.
 *
 * `null` para Shopee e Magalu de propósito, e não por esquecimento: nesses dois
 * o título publicado NÃO é o nome da peça — o Dexo monta "nome - marca - modelo
 * - ano - versão - PN". Mostrar o nome cortado como "prévia" seria mostrar um
 * texto que ninguém vai ver. Na OLX e no Facebook o nome vai cru, então o corte
 * É a prévia.
 */
function previaDoCanal(canal: Canal, texto: string): string | null {
  switch (canal) {
    case "mercado_livre":
      return sanitizeMLTitle(texto);
    case "olx":
      return texto.slice(0, OLX_CONSTANTS.TITLE_MAX_LENGTH);
    case "facebook":
      return texto.slice(0, FACEBOOK_CONSTANTS.TITLE_MAX_LENGTH);
    case "shopee":
    case "magalu":
      return null;
  }
}

export const sugerirTitulo: AiTool = {
  name: "sugerir_titulo",
  description:
    "Ajuda a escrever o título do anúncio. Devolve como esta loja já nomeia peças parecidas, as regras do canal " +
    "(limite de caracteres, o que o sistema corta, o que ele já acrescenta sozinho) e a prévia do que seria publicado. " +
    "Use quando o usuário pedir ajuda para nomear uma peça ou reclamar que o título saiu cortado no marketplace. " +
    "Quem escreve o título final é você, com base no que esta consulta devolver.",
  args: z
    .object({
      descricao: z
        .string()
        .min(3)
        .max(200)
        .describe(
          "O que é a peça, do jeito que o usuário falou. Ex.: 'farol direito do palio 2012, original'.",
        ),
      // ⭐ Vem de CANAIS — ver o comentário em descricao.ts.
      canal: z.enum(CANAIS).describe("Para qual marketplace o título é."),
    })
    .strict(),
  kind: "advisory",
  page: "produtos",
  keywords: [
    "titulo",
    "titulos",
    "nome do anuncio",
    "nomear",
    "como chamar",
    "escrever o anuncio",
    "titulo cortado",
    "olx",
    "facebook",
  ],
  sourceLabel: "Como você nomeia peças parecidas",
  handler: async (args, scope) => {
    const descricao = args.descricao.trim();
    const canal = args.canal as Canal;
    const regras = regrasDeTitulo(canal);

    const resultado = await resolverNaOrdem<Referencia>([
      {
        nivel: "proprio",
        buscar: async () => {
          const pecas = await buscarPecasParecidas(scope, descricao);
          const nomes = Array.from(
            new Set(pecas.map((p) => p.nome).filter(Boolean)),
          ).slice(0, MAX_EXEMPLOS);
          if (nomes.length === 0) return null;
          return {
            valor: {
              exemplos: nomes,
              comoLer:
                "É assim que ESTA loja nomeia peças parecidas. Siga o padrão dela — consistência ajuda o comprador e a busca do marketplace.",
              estimativa: false,
            },
            fonte: {
              kind: "proprio",
              label: "Títulos de peças parecidas no seu catálogo",
              count: nomes.length,
            } satisfies AiSource,
          };
        },
      },
      {
        // Sem exemplo no catálogo, o título sai da sua redação. O usuário
        // precisa SABER disso — é o que a fonte `estimativa` comunica.
        nivel: "estimativa",
        buscar: async () => ({
          valor: {
            exemplos: [],
            comoLer:
              "Esta loja ainda não tem peça parecida cadastrada, então não há padrão dela para seguir. Escreva o título pelas regras do canal.",
            estimativa: true,
          },
          fonte: {
            kind: "estimativa",
            note: "Título redigido pelo Bitz — não há peça parecida nesta loja para servir de referência.",
          } satisfies AiSource,
        }),
      },
    ]);

    const r = resultado.valor!;
    const previa = previaDoCanal(canal, descricao);

    return {
      canal: NOME_DO_CANAL[canal],
      consultouNaOrdem: resultado.trilha.map((p) => p.nivel),
      exemplosDaLoja: r.exemplos,
      comoLer: r.comoLer,
      regrasDoCanal: regras.map((x) => x.detalhe),
      ...(previa && previa !== descricao
        ? {
            atencao: `Publicado no ${NOME_DO_CANAL[canal]}, "${descricao}" viraria "${previa}". É a mesma regra que o Dexo aplica ao criar o anúncio.`,
          }
        : {}),
      ...(r.estimativa
        ? {
            instrucao:
              "Ao apresentar o título, DEIXE CLARO que ele foi escrito por você e não copiado de nenhuma peça já cadastrada. Peça ao usuário para conferir antes de publicar.",
          }
        : {}),
      fontes: [resultado.fonte!, ...regras.map(fonteDeRegra)],
    };
  },
};
