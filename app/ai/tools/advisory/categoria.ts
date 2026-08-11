// Tool consultiva: SUGERIR CATEGORIA do marketplace.
//
// Esta é a tool que melhor mostra por que a hierarquia precisa ser código.
//
// O motor de categoria da casa (`CategorySuggestionService`) é de dois sinais e
// ele PRÓPRIO diz de onde tirou a resposta: `source: "internal"` significa moda
// do CatalogStat (fonte 2), enquanto `"curated"`, `"alias"` e `"keyword"`
// significam mapa curado / tabela de apelidos (fonte 4). Um prompt não
// conseguiria distinguir os dois casos; aqui o próprio motor entrega a
// procedência e ela vai crua para o card de fontes.
//
// É exatamente o caso do invariante C da cadeia: um degrau declarado
// `plataforma` pode reportar `regra` (procedência mais FRACA), nunca `proprio`.
//
// Magalu não tem árvore local de categorias: a resolução acontece na hora de
// publicar, por similaridade de nome, e sem match confiável o SKU fica em
// rascunho (magalu-constants.ts:83-89). Perguntar "qual categoria do Magalu"
// não tem resposta a dar — tem um comportamento a explicar.

import { z } from "zod";

import prisma from "../../../lib/prisma";
import { MLApiService } from "../../../marketplaces/services/ml-api.service";
import { CategorySuggestionService } from "../../../marketplaces/services/category-suggestion.service";
import { OlxCategoryResolutionService } from "../../../marketplaces/services/olx-category-resolution.service";
import { FacebookCategoryResolutionService } from "../../../marketplaces/services/facebook-category-resolution.service";
import { OLX_AUTOPARTS_CATEGORY } from "../../../marketplaces/olx/olx-category-map";
import { buscarPecasParecidas, moda } from "../../advisory/own-catalog";
import {
  comoLerAgregado,
  fonteDaPlataforma,
  lerAgregadoDaPlataforma,
} from "../../advisory/platform-stats";
import { resolverNaOrdem, respondeu } from "../../advisory/source-chain";
import {
  CANAIS,
  NOME_DO_CANAL,
  type Canal,
} from "../../advisory/channel-rules";
import type { AiSource } from "../../core/types";
import type { AiTool } from "../registry";
import { texto } from "../serialize";

/**
 * Quantas peças próprias já categorizadas iguais bastam para virar padrão.
 *
 * Menor que o limiar de preço (3) de propósito: categoria é escolha DISCRETA,
 * não estimativa contínua. Duas peças parecidas colocadas na mesma categoria
 * pela mesma loja já é decisão repetida — e a terceira quase certamente vai
 * para o mesmo lugar. Uma só poderia ser o engano que ninguém corrigiu.
 */
const MIN_CATEGORIZADAS = 2;

/**
 * Os canais que têm ÁRVORE de categoria consultável no Dexo e por isso passam
 * pela cadeia de fontes. Os outros três resolvem sozinhos e saem antes.
 */
const SITE: Record<Extract<Canal, "mercado_livre" | "shopee">, string> = {
  mercado_livre: "MLB",
  shopee: "SHP",
};

/**
 * Nome legível das subcategorias de autopeças da OLX.
 *
 * ⚠️ CÓPIA CONSCIENTE, no mesmo espírito de `SHOPEE_TITLE_MAX_LEN`: os códigos
 * vivem em `OLX_AUTOPARTS_CATEGORY` mas os nomes só existem como comentário lá
 * (olx-category-map.ts:9-11) — não há como importá-los.
 * `ai-canais-olx-facebook.spec.ts` falha se entrar um código novo sem rótulo,
 * então a cópia não envelhece calada.
 */
const ROTULO_CATEGORIA_OLX: Record<number, string> = {
  [OLX_AUTOPARTS_CATEGORY.CARS]: "Carros, vans e utilitários",
  [OLX_AUTOPARTS_CATEGORY.TRUCKS]: "Caminhões",
  [OLX_AUTOPARTS_CATEGORY.MOTORCYCLES]: "Motos",
  [OLX_AUTOPARTS_CATEGORY.BOATS]: "Barcos e aeronaves",
  [OLX_AUTOPARTS_CATEGORY.BUSES]: "Ônibus",
};

interface Categoria {
  id: string;
  caminho: string | null;
  alternativas: Array<{ id: string; caminho: string | null }>;
  comoLer: string;
}

/**
 * Caminho legível de uma categoria. `MarketplaceCategory` é tabela GLOBAL (a
 * árvore do marketplace, não do cliente) — por isso não leva tenant.
 *
 * As duas chaves existem porque o sistema guarda as duas coisas: o CatalogStat
 * devolve o CUID local (internal-suggestion.usecase.ts:254 resolve por `id`),
 * enquanto o produto e o classificador do ML falam em `MLB…` (externalId).
 * Passar um pelo outro devolve `null` em silêncio, e aí o caminho some do card
 * sem ninguém notar.
 */
async function caminhoPorId(cuid: string | null): Promise<string | null> {
  if (!cuid) return null;
  try {
    const linha = await prisma.marketplaceCategory.findUnique({
      where: { id: cuid },
      select: { fullPath: true },
    });
    return linha?.fullPath ?? null;
  } catch {
    return null;
  }
}

async function caminhoPorExternalId(
  externalId: string | null,
): Promise<string | null> {
  if (!externalId) return null;
  try {
    const linha = await prisma.marketplaceCategory.findUnique({
      where: { externalId },
      select: { fullPath: true },
    });
    return linha?.fullPath ?? null;
  } catch {
    return null;
  }
}

export const sugerirCategoria: AiTool = {
  name: "sugerir_categoria",
  description:
    "Sugere em qual categoria do marketplace a peça deve ser anunciada. " +
    "Procura, nesta ordem: a categoria que esta loja já escolheu para peças iguais, o motor de categorias do Dexo " +
    "(que combina a base consolidada com o mapa curado de tipo de peça) e, se a pesquisa externa estiver habilitada, o classificador do próprio Mercado Livre. " +
    "Categoria errada é o motivo nº 1 de anúncio recusado.",
  args: z
    .object({
      titulo: z
        .string()
        .min(3)
        .max(120)
        .describe("Nome da peça com marca e modelo."),
      // ⭐ Vem de CANAIS — ver o comentário em descricao.ts.
      canal: z.enum(CANAIS).describe("Para qual marketplace."),
    })
    .strict(),
  kind: "advisory",
  page: "produtos",
  keywords: [
    "categoria",
    "categorias",
    "categorizar",
    "onde anunciar",
    "em que categoria",
    "qual categoria",
    "classificar",
    "olx",
    "facebook",
  ],
  sourceLabel: "Categoria do marketplace",
  handler: async (args, scope) => {
    const titulo = args.titulo.trim();
    const canal = args.canal as Canal;

    if (canal === "magalu") {
      return {
        temSugestao: false,
        resolvidoPeloSistema: true,
        explicacao:
          "No Magalu não existe escolha de categoria no Dexo. A categoria é resolvida na hora de publicar, por semelhança do nome da peça com a taxonomia do Magalu, com viés para o ramo de veículos e peças. Quando não há correspondência confiável, o anúncio fica como rascunho em vez de sair na categoria errada.",
        oQueFazer:
          "Se um SKU está parando em rascunho no Magalu, o caminho é melhorar o NOME da peça — é ele que a resolução usa.",
        fontes: [
          {
            kind: "regra",
            rule: "Magalu: categoria resolvida automaticamente na publicação",
          } satisfies AiSource,
        ],
      };
    }

    // ── OLX ────────────────────────────────────────────────────────────────
    //
    // Aqui a cadeia de fontes não se aplica, e não é economia: a resolução é uma
    // FUNÇÃO PURA do nome da peça (de-para de veículo + default), sem rede e sem
    // banco. Perguntar "que categoria esta loja já usou em peças parecidas" não
    // acrescentaria nada — a resposta seria a mesma que a função dá, porque foi
    // a função que escolheu aquelas também.
    //
    // É a MESMA chamada de `GET /marketplace/olx/category-suggest`
    // (marketplace.routes.ts:3443) e a mesma da criação do anúncio. O Bitz
    // responde o que a tela mostra porque é a mesma função.
    if (canal === "olx") {
      const id = OlxCategoryResolutionService.resolveCategoryId({
        name: titulo,
      });
      const rotulo = id != null ? (ROTULO_CATEGORIA_OLX[id] ?? null) : null;

      return {
        temSugestao: id != null,
        resolvidoPeloSistema: true,
        canal: NOME_DO_CANAL[canal],
        categoria: id != null ? { id: String(id), caminho: rotulo } : null,
        explicacao:
          "Na OLX a categoria do anúncio de autopeça é o TIPO DE VEÍCULO (carro, caminhão, moto, barco, ônibus) — não o tipo de peça. O tipo da peça vai em outro campo do anúncio, preenchido pelo Dexo.",
        comoLer:
          "O Dexo escolhe o veículo pela palavra no NOME da peça e cai em carros quando não acha nenhuma. É por isso que 'Retrovisor Moto Honda' vai para Motos e 'Suporte do Motor Gol' não vai — o casamento é por palavra inteira, e 'motor' não é 'moto'.",
        oQueFazer:
          "Para mandar a peça para outro veículo, o caminho é o nome dela ou o campo de categoria da OLX no cadastro do produto — esse campo, quando preenchido, vence tudo.",
        fontes: [
          {
            kind: "regra",
            rule: "Resolução de categoria da OLX — de-para de veículo pelo nome da peça",
          } satisfies AiSource,
        ],
      };
    }

    // ── Facebook ───────────────────────────────────────────────────────────
    //
    // Mesmo desenho da OLX, e pela mesma razão (função pura, offline). O que
    // muda é a taxonomia: a Meta não expõe árvore consultável, e o sinal de
    // categoria é o `google_product_category`, que já é um caminho legível.
    if (canal === "facebook") {
      const caminho = FacebookCategoryResolutionService.resolveCategory({
        name: titulo,
      });

      return {
        temSugestao: Boolean(caminho),
        resolvidoPeloSistema: true,
        canal: NOME_DO_CANAL[canal],
        categoria: { id: caminho, caminho },
        explicacao:
          "No Facebook a categoria do item de catálogo é a taxonomia de produtos do Google (google_product_category). O Dexo escolhe entre peça de carro, de moto e de embarcação pela palavra no NOME da peça, e cai em peça de carro quando não acha nenhuma.",
        oQueFazer:
          "Para mandar a peça para outra taxonomia, o caminho é o nome dela ou o campo de categoria do Facebook no cadastro do produto — esse campo, quando preenchido, vence tudo.",
        fontes: [
          {
            kind: "regra",
            rule: "Resolução de categoria do Facebook — de-para de veículo pelo nome da peça",
          } satisfies AiSource,
        ],
      };
    }

    const siteId = SITE[canal];

    const resultado = await resolverNaOrdem<Categoria>([
      {
        nivel: "proprio",
        buscar: async () => {
          const pecas = await buscarPecasParecidas(scope, titulo);
          if (pecas.length < MIN_CATEGORIZADAS) return null;

          if (canal === "mercado_livre") {
            const ids = pecas.map((p) => p.categoriaMlId);
            const escolhida = moda(ids.filter((v): v is string => !!v));
            if (!escolhida) return null;
            const quantas = ids.filter((v) => v === escolhida).length;
            if (quantas < MIN_CATEGORIZADAS) return null;
            const caminho =
              pecas.find((p) => p.categoriaMlId === escolhida)
                ?.categoriaMlCaminho ?? null;
            return {
              valor: {
                id: escolhida,
                caminho,
                alternativas: [],
                comoLer: `Esta loja já colocou ${quantas} peças parecidas nesta categoria.`,
              },
              fonte: {
                kind: "proprio",
                label: "Categoria que você já usou em peças iguais",
                count: quantas,
              } satisfies AiSource,
            };
          }

          const ids = pecas.map((p) => p.categoriaShopeeId);
          const escolhida = moda(ids.filter((v): v is string => !!v));
          if (!escolhida) return null;
          const quantas = ids.filter((v) => v === escolhida).length;
          if (quantas < MIN_CATEGORIZADAS) return null;
          return {
            valor: {
              id: escolhida,
              caminho: await caminhoPorExternalId(escolhida),
              alternativas: [],
              comoLer: `Esta loja já colocou ${quantas} peças parecidas nesta categoria.`,
            },
            fonte: {
              kind: "proprio",
              label: "Categoria que você já usou em peças iguais",
              count: quantas,
            } satisfies AiSource,
          };
        },
      },
      {
        // A base consolidada, com o número REAL de amostras. Sai daqui, e não do
        // motor de categorias, porque o motor não expõe quantas peças
        // sustentaram a moda — e `sampleSize` no card tem de ser um número de
        // verdade, não um proxy convertido de "quantidade de sinais".
        nivel: "plataforma",
        buscar: async () => {
          const agregado = await lerAgregadoDaPlataforma(titulo);
          if (!agregado) return null;
          const cuidOuExterno =
            canal === "mercado_livre"
              ? agregado.categoriaMlId
              : agregado.categoriaShopeeId;
          if (!cuidOuExterno) return null;

          const caminho =
            canal === "mercado_livre"
              ? await caminhoPorId(cuidOuExterno)
              : await caminhoPorExternalId(cuidOuExterno);

          return {
            valor: {
              id: cuidOuExterno,
              caminho,
              alternativas: [],
              comoLer: `${comoLerAgregado(agregado)} Esta é a categoria mais comum entre elas.`,
            },
            fonte: fonteDaPlataforma(agregado),
          };
        },
      },
      {
        // O motor de dois sinais da casa: mapa curado de tipo de peça + tabela
        // de apelidos + palavras do caminho. Determinístico, sem rede.
        nivel: "regra",
        buscar: async () => {
          const r = await CategorySuggestionService.suggestFromProduct(
            { title: titulo },
            siteId,
          );
          const top = r.suggestions[0];
          if (!top) return null;

          return {
            valor: {
              id: top.categoryId,
              caminho: texto(top.fullPath, 160),
              alternativas: r.suggestions.slice(1, 3).map((s) => ({
                id: s.categoryId,
                caminho: texto(s.fullPath, 160),
              })),
              comoLer: `Categoria escolhida pelo motor do Dexo${top.reasons?.length ? ` (${texto(top.reasons.slice(0, 2).join("; "), 140)})` : ""}.`,
            },
            fonte: {
              kind: "regra",
              // O motor diz sozinho qual sinal venceu; repassamos cru em vez de
              // rotular por fora.
              rule: `Motor de categorias do Dexo — ${NOME_DO_CANAL[canal]}, sinal "${top.source}"`,
            } satisfies AiSource,
          };
        },
      },
      {
        nivel: "externa",
        buscar: async () => {
          if (canal !== "mercado_livre") return null;
          const id = await MLApiService.suggestCategoryId("MLB", titulo);
          if (!id) return null;
          return {
            valor: {
              id,
              caminho: await caminhoPorExternalId(id),
              alternativas: [],
              comoLer:
                "Esta categoria veio do classificador do próprio Mercado Livre, pelo nome da peça.",
            },
            fonte: {
              kind: "externa",
              provider: "mercado-livre",
              ref: id,
            } satisfies AiSource,
          };
        },
      },
    ]);

    const consultouNaOrdem = resultado.trilha.map((p) => p.nivel);

    if (!respondeu(resultado)) {
      return {
        temSugestao: false,
        consultouNaOrdem,
        motivo: `Nenhuma fonte devolveu categoria para "${titulo}" no ${NOME_DO_CANAL[canal]}.`,
        instrucao:
          "NÃO invente um código de categoria. Sugira ao usuário abrir o cadastro da peça e usar o botão de sugerir categoria, ou escrever o nome da peça de forma mais específica (tipo de peça + marca + modelo).",
        fontes: [] as AiSource[],
      };
    }

    const c = resultado.valor!;
    return {
      temSugestao: true,
      consultouNaOrdem,
      canal: NOME_DO_CANAL[canal],
      categoria: { id: c.id, caminho: c.caminho },
      alternativas: c.alternativas,
      comoLer: c.caminho
        ? c.comoLer
        : `${c.comoLer} O caminho completo desta categoria não está espelhado no Dexo — mostre o código ao usuário.`,
      atencao:
        "Categoria é o campo que mais derruba anúncio. Confira o caminho antes de publicar; o Dexo desce até a folha na hora de anunciar, então uma categoria-pai pode virar outra folha.",
      fontes: [resultado.fonte!],
    };
  },
};
