// Tool consultiva: SUGERIR MEDIDAS (peso e dimensões).
//
// Cadeia de três degraus, e também SEM estimativa do modelo no fim. O motivo
// está escrito no código da casa, em ml-measurements.ts:278-282: medida acima
// dos limites dos Correios "causa rejeição ou, pior, BAN SILENCIOSO da conta".
// Um chute de dimensão não custa um anúncio — pode custar a conta do cliente no
// Mercado Livre. Sem base, não há palpite.
//
// O terceiro degrau é `regra` e não `plataforma`: a tabela de medidas por
// categoria é uma referência de EMBALAGEM montada por categoria do ML, não uma
// medição de peça nenhuma. É o pior dos três, e por isso vem por último — mas
// ainda é melhor que inventar, porque é o mesmo número que o próprio Dexo
// preenche sozinho ao publicar (product.routes.ts:624).
//
// Fora da cadeia, sempre: a conferência contra o Mercado Envios. Ela não é uma
// fonte alternativa — é restrição, e vale sobre a resposta venha ela de onde
// vier, inclusive sobre medida que o próprio lojista informou.

import { z } from "zod";

import {
  LIMITES_MERCADO_ENVIOS,
  checarMercadoEnvios,
} from "../../advisory/channel-rules";
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
import { getMeasurementsForCategory } from "../../../lib/ml-measurements";
import { CategorySuggestionService } from "../../../marketplaces/services/category-suggestion.service";
import type { AiSource } from "../../core/types";
import type { AiTool } from "../registry";
import { num } from "../serialize";

interface Medidas {
  alturaCm: number | null;
  larguraCm: number | null;
  comprimentoCm: number | null;
  pesoKg: number | null;
  baseadoEm: string;
  comoLer: string;
}

/** Uma peça só serve de referência de medida quando tem as quatro. */
function completa(p: {
  alturaCm: number | null;
  larguraCm: number | null;
  comprimentoCm: number | null;
  pesoKg: number | null;
}): boolean {
  return (
    (p.alturaCm ?? 0) > 0 &&
    (p.larguraCm ?? 0) > 0 &&
    (p.comprimentoCm ?? 0) > 0 &&
    (p.pesoKg ?? 0) > 0
  );
}

export const sugerirMedidas: AiTool = {
  name: "sugerir_medidas",
  description:
    "Sugere peso e dimensões (altura, largura, comprimento) para uma peça, para o lojista preencher o anúncio. " +
    "Procura, nesta ordem: peças iguais no catálogo da própria loja, base consolidada do Dexo, e a tabela de embalagem por categoria do Mercado Envios. " +
    "Sempre confere o resultado contra os limites dos Correios. Passe só o nome da peça, não a pergunta inteira.",
  args: z
    .object({
      titulo: z
        .string()
        .min(3)
        .max(120)
        .describe("Nome da peça com marca e modelo."),
      categoria: z
        .string()
        .min(2)
        .max(160)
        .optional()
        .describe(
          "Categoria do Mercado Livre, se o usuário já souber. Ex.: 'Faróis e Lanternas'. Opcional.",
        ),
    })
    .strict(),
  kind: "advisory",
  page: "produtos",
  keywords: [
    "medida",
    "medidas",
    "peso",
    "dimensao",
    "dimensoes",
    "altura",
    "largura",
    "comprimento",
    "kg",
    "embalagem",
    "cubagem",
    "frete da peca",
  ],
  sourceLabel: "Referência de peso e medidas",
  handler: async (args, scope) => {
    const titulo = args.titulo.trim();

    const resultado = await resolverNaOrdem<Medidas>([
      {
        nivel: "proprio",
        buscar: async () => {
          const pecas = await buscarPecasParecidas(scope, titulo);
          const comMedida = pecas.filter(completa);
          if (comMedida.length < MIN_AMOSTRA_PROPRIA) return null;
          return {
            valor: {
              alturaCm: mediana(comMedida.map((p) => p.alturaCm)),
              larguraCm: mediana(comMedida.map((p) => p.larguraCm)),
              comprimentoCm: mediana(comMedida.map((p) => p.comprimentoCm)),
              pesoKg: mediana(comMedida.map((p) => p.pesoKg)),
              baseadoEm: `${comMedida.length} peças medidas nesta loja`,
              comoLer: `Mediana das medidas que ESTA loja já cadastrou em ${comMedida.length} peças parecidas.`,
            },
            fonte: {
              kind: "proprio",
              label: "Peças parecidas já medidas no seu catálogo",
              count: comMedida.length,
            } satisfies AiSource,
          };
        },
      },
      {
        nivel: "plataforma",
        buscar: async () => {
          const agregado = await lerAgregadoDaPlataforma(titulo);
          if (!agregado) return null;
          const temAlgo =
            agregado.pesoKg !== null ||
            agregado.alturaCm !== null ||
            agregado.larguraCm !== null ||
            agregado.comprimentoCm !== null;
          if (!temAlgo) return null;
          return {
            valor: {
              alturaCm: agregado.alturaCm,
              larguraCm: agregado.larguraCm,
              comprimentoCm: agregado.comprimentoCm,
              pesoKg: agregado.pesoKg,
              baseadoEm: `${agregado.sampleSize} peças da base consolidada`,
              comoLer: comoLerAgregado(agregado),
            },
            fonte: fonteDaPlataforma(agregado),
          };
        },
      },
      {
        nivel: "regra",
        buscar: async () => {
          // Sem categoria informada, derivamos pelo MESMO motor que a tela de
          // cadastro usa. Falha aqui não é problema: `getMeasurementsForCategory`
          // ainda tenta casar pelo nome da peça.
          let caminho = args.categoria?.trim() ?? "";
          if (!caminho) {
            const sugestoes = await CategorySuggestionService.suggestFromTitle(
              titulo,
              "MLB",
            );
            caminho = sugestoes.suggestions[0]?.fullPath ?? "";
          }

          const m = getMeasurementsForCategory(caminho || undefined, titulo);
          if (!m) return null;

          const altura = num(m.heightCm);
          const largura = num(m.widthCm);
          const comprimento = num(m.lengthCm);
          const peso = num(m.weightKg);
          if (
            altura === null &&
            largura === null &&
            comprimento === null &&
            peso === null
          ) {
            return null;
          }

          const rotulo = caminho
            ? `tabela de embalagem do Mercado Envios para "${caminho}"`
            : "tabela de embalagem do Mercado Envios";

          return {
            valor: {
              alturaCm: altura,
              larguraCm: largura,
              comprimentoCm: comprimento,
              pesoKg: peso,
              baseadoEm: rotulo,
              comoLer:
                "Estes valores são a EMBALAGEM típica da categoria, não a medição desta peça. " +
                "É o mesmo número que o Dexo preenche sozinho ao publicar quando o produto vai sem medida. " +
                "Serve para não travar o anúncio; conferir na balança continua sendo o certo.",
            },
            fonte: {
              kind: "regra",
              rule: `Tabela de medidas por categoria do Mercado Envios${caminho ? ` (${caminho})` : ""}`,
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
        motivo:
          "Não achei peças medidas no catálogo desta loja, nem família com amostra suficiente na base consolidada, nem categoria correspondente na tabela do Mercado Envios.",
        instrucao:
          "NÃO invente medida nem peso. Medida errada faz o Mercado Livre rejeitar o anúncio e, repetido, suspender a conta. Peça ao usuário para pesar e medir a peça.",
        limitesDoMercadoEnvios: LIMITES_MERCADO_ENVIOS,
        fontes: [] as AiSource[],
      };
    }

    const m = resultado.valor!;
    const problemas = checarMercadoEnvios(m);

    return {
      temSugestao: true,
      consultouNaOrdem,
      medidas: {
        alturaCm: m.alturaCm,
        larguraCm: m.larguraCm,
        comprimentoCm: m.comprimentoCm,
        pesoKg: m.pesoKg,
      },
      baseadoEm: m.baseadoEm,
      comoLer: m.comoLer,
      limitesDoMercadoEnvios: LIMITES_MERCADO_ENVIOS,
      ...(problemas.length > 0
        ? {
            atencao:
              `ESTAS MEDIDAS NÃO PASSAM NO MERCADO ENVIOS: ${problemas.join("; ")}. ` +
              "Avise o usuário: com elas o anúncio é recusado, e insistir pode suspender a conta. " +
              "Esta peça provavelmente precisa de frete próprio ou de transportadora.",
          }
        : {
            observacao:
              "Medidas dentro dos limites do Mercado Envios. Confirme na balança antes de publicar.",
          }),
      fontes: [
        resultado.fonte!,
        {
          kind: "regra",
          rule: `Limites do Mercado Envios: maior lado ${LIMITES_MERCADO_ENVIOS.maiorLadoCm} cm, soma dos lados ${LIMITES_MERCADO_ENVIOS.somaDosLadosCm} cm, peso ${LIMITES_MERCADO_ENVIOS.pesoKg} kg`,
        } satisfies AiSource,
      ],
    };
  },
};
