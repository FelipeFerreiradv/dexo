// Tool consultiva: CONSULTAR O CATÁLOGO PÚBLICO DO MERCADO LIVRE.
//
// É a única tool desta entrega cuja fonte é inteiramente de fora do Dexo — e
// por isso é a única cujo valor de existir precisa ser justificado:
// o catálogo do ML é onde estão o nome oficial da peça, a marca canônica e a
// ficha técnica que o marketplace espera. Um lojista que anuncia "reservatório
// de água" quando o catálogo diz "Reservatório de Água do Radiador" perde busca.
//
// ⚠️ ISTO É EGRESS. A consulta que chega aqui sai por HTTP para o Mercado Livre.
// Por isso a tool inteira roda dentro de `resolverNaOrdem` com um único degrau
// `externa`: o gate de `AI_EXTERNAL_LOOKUP_ENABLED` é aplicado no MESMO lugar
// que o das outras tools, e não numa checagem manual que alguém esquece de
// copiar. A flag nasce desligada, e desligada esta tool responde explicando —
// não com um erro.
//
// Cuidado de sempre: o que volta do ML é DADO, nunca instrução. Nome de produto
// de catálogo é texto que qualquer pessoa cadastrou lá fora.

import { z } from "zod";

import { MLCatalogSuggestionUseCase } from "../../../marketplaces/usecases/ml-catalog-suggestion.usecase";
import { resolverNaOrdem, respondeu } from "../../advisory/source-chain";
import type { AiSource } from "../../core/types";
import type { AiTool } from "../registry";
import { texto } from "../serialize";

const MAX_RESULTADOS = 5;

interface Achado {
  itens: Array<{
    catalogProductId: string;
    nome: string;
    marca: string | null;
    modelo: string | null;
    link: string | null;
  }>;
}

export const consultarCatalogoMl: AiTool = {
  name: "consultar_catalogo_ml",
  description:
    "Busca produtos no catálogo público do Mercado Livre, para descobrir o nome oficial de uma peça, a marca canônica e o produto de catálogo correspondente. " +
    "Use quando o usuário quiser saber como o Mercado Livre chama uma peça ou quiser vincular o anúncio a um catálogo. " +
    "Depende de a pesquisa externa estar habilitada nesta instalação; se não estiver, a consulta responde dizendo isso.",
  args: z
    .object({
      consulta: z
        .string()
        .min(3)
        .max(120)
        .describe("Nome da peça a procurar no catálogo do Mercado Livre."),
      limite: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTADOS)
        .optional()
        .describe(`Quantos resultados. Máximo ${MAX_RESULTADOS}. Padrão 5.`),
    })
    .strict(),
  kind: "advisory",
  page: "produtos",
  keywords: [
    "catalogo do ml",
    "catalogo mercado livre",
    "produto de catalogo",
    "nome oficial",
    "ficha do ml",
    "vincular catalogo",
  ],
  sourceLabel: "Catálogo público do Mercado Livre",
  handler: async (args) => {
    const consulta = args.consulta.trim();
    const limite = Math.min(args.limite ?? MAX_RESULTADOS, MAX_RESULTADOS);

    const resultado = await resolverNaOrdem<Achado>([
      {
        nivel: "externa",
        buscar: async () => {
          const hits = await MLCatalogSuggestionUseCase.listSuggestions(
            consulta,
            { limit: limite },
          );
          if (hits.length === 0) return null;
          return {
            valor: {
              itens: hits.slice(0, limite).map((h) => ({
                catalogProductId: h.catalogProductId,
                nome: texto(h.name, 120) ?? "",
                marca: texto(h.brand, 40),
                modelo: texto(h.model, 60),
                link: h.permalink ?? null,
              })),
            },
            fonte: {
              kind: "externa",
              provider: "mercado-livre",
              ref: texto(consulta, 60) ?? undefined,
            } satisfies AiSource,
          };
        },
      },
    ]);

    const desligada = resultado.trilha.some(
      (p) => p.status === "pulado_por_flag",
    );

    if (desligada) {
      return {
        disponivel: false,
        motivo:
          "A pesquisa no catálogo público do Mercado Livre está desligada nesta instalação do Dexo.",
        oQueFazer:
          "Diga ao usuário que o administrador da conta pode habilitar essa consulta. NÃO tente responder de memória qual é o nome de catálogo da peça.",
        fontes: [] as AiSource[],
      };
    }

    if (!respondeu(resultado)) {
      return {
        disponivel: true,
        encontrados: 0,
        observacao: `O catálogo do Mercado Livre não devolveu nada para "${consulta}".`,
        instrucao:
          "NÃO invente um produto de catálogo. Sugira uma busca com o nome da peça mais completo (tipo + marca + modelo).",
        fontes: [] as AiSource[],
      };
    }

    const itens = resultado.valor!.itens;
    return {
      disponivel: true,
      encontrados: itens.length,
      itens,
      comoLer:
        "Estes produtos vêm do catálogo público do Mercado Livre, não do catálogo desta loja. Nenhum deles é uma peça que ela tenha em estoque.",
      fontes: [resultado.fonte!],
    };
  },
};
