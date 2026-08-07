// Tool consultiva: SUGERIR PREÇO.
//
// A cadeia tem DOIS degraus e para por aí — sem regra, sem catálogo externo,
// sem estimativa do modelo. É a decisão mais importante deste arquivo e ela é
// deliberada:
//
//   um preço inventado não parece inventado.
//
// Peso errado o lojista descobre no frete. Categoria errada o marketplace
// recusa. Preço errado só aparece três meses depois, na forma de peça encalhada
// ou de dinheiro deixado na mesa — e nesse ponto ninguém lembra que veio de uma
// "estimativa". Então: ou existe base, ou o Bitz diz que não sabe.
//
// ⭐ E o que ele NUNCA sabe: o custo. `costPrice` e `markup` são campo proibido
// no tool-runner, para todo mundo, admin inclusive. Isso significa que a
// sugestão daqui é sempre uma referência de MERCADO — nunca uma conta de
// margem. O retorno diz isso em voz alta, porque um número de preço sem essa
// ressalva convida exatamente à leitura errada.

import { z } from "zod";

import {
  MIN_AMOSTRA_PROPRIA,
  buscarPecasParecidas,
  mediana,
} from "../../advisory/own-catalog";
import {
  comoLerAgregado,
  fonteDaPlataforma,
  lerAgregadoDaPlataforma,
} from "../../advisory/platform-stats";
import { resolverNaOrdem, respondeu } from "../../advisory/source-chain";
import type { AiSource } from "../../core/types";
import type { AiTool } from "../registry";

interface Sugestao {
  precoSugerido: number;
  faixa: { minimo: number | null; maximo: number | null };
  baseadoEm: number;
  origem: string;
  comoLer: string;
  exemplos?: Array<{ sku: string; nome: string; preco: number | null }>;
}

export const sugerirPreco: AiTool = {
  name: "sugerir_preco",
  description:
    "Sugere um preço de VENDA de referência para uma peça, a partir do que a própria loja já cobra por peças iguais e, " +
    "se não houver, da mediana da base consolidada do Dexo (peças parecidas de todas as lojas, mínimo de 5 amostras). " +
    "Passe só o nome da peça com marca e modelo (ex.: 'farol dianteiro direito palio 2012'), NUNCA a pergunta inteira. " +
    "Se não houver base, devolve temSugestao:false — e aí NÃO existe preço para dar. " +
    "NÃO considera custo de compra nem margem: o Bitz não tem acesso a esses dados.",
  args: z
    .object({
      titulo: z
        .string()
        .min(3)
        .max(120)
        .describe(
          "Nome da peça com marca e modelo. Ex.: 'parachoque dianteiro gol g5'.",
        ),
    })
    .strict(),
  kind: "advisory",
  page: "produtos",
  keywords: [
    "preco",
    "cobrar",
    "quanto vale",
    "quanto vender",
    "precificar",
    "precifica",
    "valor da peca",
    "por quanto",
    "tabela de preco",
  ],
  sourceLabel: "Referência de preço",
  handler: async (args, scope) => {
    const titulo = args.titulo.trim();

    const resultado = await resolverNaOrdem<Sugestao>([
      // 1. O catálogo do próprio cliente.
      {
        nivel: "proprio",
        buscar: async () => {
          const pecas = await buscarPecasParecidas(scope, titulo);
          const comPreco = pecas.filter(
            (p) => typeof p.preco === "number" && p.preco > 0,
          );
          if (comPreco.length < MIN_AMOSTRA_PROPRIA) return null;

          const precos = comPreco.map((p) => p.preco);
          const meio = mediana(precos);
          if (meio === null) return null;

          const ordenados = precos
            .filter((v): v is number => typeof v === "number")
            .sort((a, b) => a - b);

          return {
            valor: {
              precoSugerido: meio,
              faixa: {
                minimo: ordenados[0] ?? null,
                maximo: ordenados[ordenados.length - 1] ?? null,
              },
              baseadoEm: comPreco.length,
              origem: "peças parecidas no seu próprio catálogo",
              comoLer: `Mediana do que ESTA loja já cobra por ${comPreco.length} peças parecidas. É o preço da casa, não uma média de mercado.`,
              exemplos: comPreco
                .slice(0, 5)
                .map((p) => ({ sku: p.sku, nome: p.nome, preco: p.preco })),
            },
            fonte: {
              kind: "proprio",
              label: "Peças parecidas no seu catálogo",
              count: comPreco.length,
            } satisfies AiSource,
          };
        },
      },
      // 2. A base consolidada (CatalogStat), com o gate de 5 amostras.
      {
        nivel: "plataforma",
        buscar: async () => {
          const agregado = await lerAgregadoDaPlataforma(titulo);
          if (!agregado || agregado.precoMediana === null) return null;
          return {
            valor: {
              precoSugerido: agregado.precoMediana,
              faixa: { minimo: null, maximo: null },
              baseadoEm: agregado.sampleSize,
              origem: "base consolidada do Dexo",
              comoLer: comoLerAgregado(agregado),
            },
            fonte: fonteDaPlataforma(agregado),
          };
        },
      },
    ]);

    const consultouNaOrdem = resultado.trilha.map((p) => p.nivel);

    if (!respondeu(resultado)) {
      return {
        temSugestao: false,
        consultouNaOrdem,
        motivo:
          "Não achei peças parecidas no catálogo desta loja nem família com amostra suficiente na base consolidada do Dexo (mínimo de 5 peças).",
        oQueFazer:
          "Peça ao usuário o nome da peça com marca e modelo, ou sugira que ele consulte anúncios do mesmo item no marketplace.",
        // ⭐ Instrução dura: sem base, não há preço. Nem aproximado, nem 'em
        // torno de'. O modelo tem tendência a preencher e aqui isso é caro.
        instrucao:
          "NÃO invente um preço, NÃO dê faixa, NÃO diga 'em torno de'. Diga que não há base e ofereça o que fazer.",
        fontes: [] as AiSource[],
      };
    }

    const s = resultado.valor!;
    return {
      temSugestao: true,
      consultouNaOrdem,
      precoSugerido: s.precoSugerido,
      faixa: s.faixa,
      baseadoEm: s.baseadoEm,
      origem: s.origem,
      comoLer: s.comoLer,
      ...(s.exemplos ? { exemplos: s.exemplos } : {}),
      atencao:
        "Isto é referência de preço de VENDA. Não entra na conta o custo de compra da peça nem a margem — o Bitz não tem acesso a esses dados, por regra. Quem fecha o preço é o lojista.",
      fontes: [resultado.fonte!],
    };
  },
};
