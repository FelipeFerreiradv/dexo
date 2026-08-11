// Tool consultiva: SUGERIR COMPATIBILIDADES (em que carros a peça serve).
//
// Aqui a cadeia tem os três degraus e o quinto — `externa` —, porque o catálogo
// público do Mercado Livre é, de fato, a melhor fonte de aplicação veicular que
// existe ao alcance do Dexo. Ele entra por último e SÓ com
// `AI_EXTERNAL_LOOKUP_ENABLED=true`, que nasce desligada: consultar o ML manda
// o título da peça para fora do perímetro, e essa é uma decisão do dono da
// conta, não um default meu.
//
// Sem estimativa do modelo, de novo, e este é o caso mais claro dos três:
// compatibilidade errada é peça errada na casa do comprador. Devolução, nota de
// crédito, reputação no marketplace. "Deve servir no Palio da mesma geração" é
// exatamente o tipo de frase plausível que um modelo produz sem esforço e que
// custa caro para quem acredita nela.
//
// ⚠️ A leitura das compatibilidades PRÓPRIAS é a única consulta direta ao
// Prisma nesta fase. `listProducts` não traz `compatibilities` no select
// (product.repository.ts:418-500) e `getDetail` traria junto log de estoque,
// anúncios e sucata para responder "em que carro serve". Os ids vêm de uma
// busca JÁ escopada pelo usecase, e o `where` repete `userId` mesmo assim.

import { z } from "zod";

import prisma from "../../../lib/prisma";
import { MLCatalogSuggestionUseCase } from "../../../marketplaces/usecases/ml-catalog-suggestion.usecase";
import { buscarPecasParecidas } from "../../advisory/own-catalog";
import {
  comoLerAgregado,
  fonteDaPlataforma,
  lerAgregadoDaPlataforma,
} from "../../advisory/platform-stats";
import { resolverNaOrdem, respondeu } from "../../advisory/source-chain";
import type { AiSource } from "../../core/types";
import type { AiTool } from "../registry";
import { texto } from "../serialize";

/** Teto de veículos devolvidos. Uma peça de motor casa com dezenas. */
const MAX_VEICULOS = 25;

export interface Compat {
  marca: string;
  modelo: string;
  anoDe: number | null;
  anoAte: number | null;
  versao: string | null;
}

interface Achado {
  veiculos: Compat[];
  baseadoEm: string;
  comoLer: string;
}

const chaveDe = (c: Compat) =>
  `${c.marca}|${c.modelo}|${c.anoDe ?? ""}|${c.anoAte ?? ""}|${c.versao ?? ""}`.toLowerCase();

/** Remove repetido e aplica o teto, mantendo a ordem de chegada. */
function normalizar(lista: Compat[]): Compat[] {
  const vistos = new Set<string>();
  const saida: Compat[] = [];
  for (const c of lista) {
    if (!c.marca || !c.modelo) continue;
    const chave = chaveDe(c);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push({
      marca: texto(c.marca, 40) ?? "",
      modelo: texto(c.modelo, 60) ?? "",
      anoDe: c.anoDe ?? null,
      anoAte: c.anoAte ?? null,
      versao: texto(c.versao, 60),
    });
    if (saida.length >= MAX_VEICULOS) break;
  }
  return saida;
}

export const sugerirCompatibilidades: AiTool = {
  name: "sugerir_compatibilidades",
  description:
    "Diz em quais veículos uma peça serve (marca, modelo, faixa de anos, versão). " +
    "Procura, nesta ordem: peças iguais já cadastradas nesta loja com compatibilidade preenchida, base consolidada do Dexo, " +
    "e — só se o dono da conta tiver habilitado a pesquisa externa — o catálogo público do Mercado Livre. " +
    "Se nada responder, devolve temSugestao:false e NÃO existe lista para dar.",
  args: z
    .object({
      titulo: z
        .string()
        .min(3)
        .max(120)
        .describe("Nome da peça com marca e modelo do veículo."),
      marca: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("Marca do veículo, se o usuário disse. Ex.: 'Fiat'."),
      modelo: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe("Modelo do veículo, se o usuário disse. Ex.: 'Palio'."),
    })
    .strict(),
  kind: "advisory",
  page: "produtos",
  keywords: [
    "compativel",
    "compatibilidade",
    "compatibilidades",
    "serve em",
    "serve no",
    "aplicacao",
    "quais carros",
    "que carro",
    "veiculos compativeis",
    "da certo no",
  ],
  sourceLabel: "Aplicação veicular",
  handler: async (args, scope) => {
    const titulo = [args.titulo, args.marca, args.modelo]
      .filter(Boolean)
      .join(" ")
      .trim();

    const resultado = await resolverNaOrdem<Achado>([
      {
        nivel: "proprio",
        buscar: async () => {
          const pecas = await buscarPecasParecidas(scope, args.titulo.trim());
          if (pecas.length === 0) return null;

          const ids = pecas.slice(0, 10).map((p) => p.id);
          const linhas = await prisma.productCompatibility.findMany({
            // O tenant aparece DUAS vezes de propósito: os ids já vieram de uma
            // busca escopada, e ainda assim o `where` exige o dono. Custa nada e
            // sobrevive a alguém mudar a origem dos ids um dia.
            where: {
              productId: { in: ids },
              product: { userId: scope.dataOwnerId },
            },
            select: {
              brand: true,
              model: true,
              yearFrom: true,
              yearTo: true,
              version: true,
            },
            take: 200,
          });
          if (linhas.length === 0) return null;

          const veiculos = normalizar(
            linhas.map((l) => ({
              marca: l.brand,
              modelo: l.model,
              anoDe: l.yearFrom,
              anoAte: l.yearTo,
              versao: l.version,
            })),
          );
          if (veiculos.length === 0) return null;

          return {
            valor: {
              veiculos,
              baseadoEm: `${ids.length} peças parecidas desta loja`,
              comoLer:
                "É a compatibilidade que ESTA loja já cadastrou em peças parecidas. Foi alguém daqui que preencheu — confira antes de confiar.",
            },
            fonte: {
              kind: "proprio",
              label: "Compatibilidades já cadastradas nesta loja",
              count: veiculos.length,
            } satisfies AiSource,
          };
        },
      },
      {
        nivel: "plataforma",
        buscar: async () => {
          const agregado = await lerAgregadoDaPlataforma(titulo);
          if (!agregado || agregado.compatibilidades.length === 0) return null;
          const veiculos = normalizar(agregado.compatibilidades);
          if (veiculos.length === 0) return null;
          return {
            valor: {
              veiculos,
              baseadoEm: `${agregado.sampleSize} peças da base consolidada`,
              comoLer: comoLerAgregado(agregado),
            },
            fonte: fonteDaPlataforma(agregado),
          };
        },
      },
      {
        nivel: "externa",
        buscar: async () => {
          // Duas chamadas ao ML: achar o catalog product e abrir a ficha dele.
          // Falha vira `falhou` na trilha; o turno segue.
          const hits = await MLCatalogSuggestionUseCase.listSuggestions(
            titulo,
            { limit: 3 },
          );
          const primeiro = hits[0];
          if (!primeiro) return null;

          const detalhe = await MLCatalogSuggestionUseCase.getProductDetail(
            primeiro.catalogProductId,
          );
          if (!detalhe || detalhe.compatibilities.length === 0) return null;

          const veiculos = normalizar(
            detalhe.compatibilities.map((c) => ({
              marca: c.brand,
              modelo: c.model,
              anoDe: c.yearFrom,
              anoAte: c.yearTo,
              versao: c.version,
            })),
          );
          if (veiculos.length === 0) return null;

          return {
            valor: {
              veiculos,
              baseadoEm: `catálogo público do Mercado Livre — "${detalhe.name}"`,
              comoLer:
                "Esta lista veio do catálogo do Mercado Livre para um produto de nome parecido. " +
                "É a fonte mais completa e a menos garantida: quem casou o nome foi uma busca por texto, não o part number.",
            },
            fonte: {
              kind: "externa",
              provider: "mercado-livre",
              ref: texto(detalhe.name, 90) ?? primeiro.catalogProductId,
            } satisfies AiSource,
          };
        },
      },
    ]);

    const consultouNaOrdem = resultado.trilha.map((p) => p.nivel);
    const externaPulada = resultado.trilha.some(
      (p) => p.nivel === "externa" && p.status === "pulado_por_flag",
    );

    if (!respondeu(resultado)) {
      return {
        temSugestao: false,
        consultouNaOrdem,
        motivo:
          "Nenhuma peça parecida desta loja tem compatibilidade preenchida, e a base consolidada não tem família com amostra suficiente.",
        ...(externaPulada
          ? {
              observacao:
                "A pesquisa no catálogo público do Mercado Livre está desligada nesta instalação do Dexo. O administrador pode habilitá-la.",
            }
          : {}),
        instrucao:
          "NÃO invente em que carros a peça serve. Compatibilidade errada é peça errada na mão do comprador. Peça ao usuário o part number, ou sugira conferir no catálogo do fabricante.",
        fontes: [] as AiSource[],
      };
    }

    const a = resultado.valor!;
    return {
      temSugestao: true,
      consultouNaOrdem,
      veiculos: a.veiculos,
      quantidade: a.veiculos.length,
      baseadoEm: a.baseadoEm,
      comoLer: a.comoLer,
      atencao:
        "Compatibilidade é sugestão, não garantia. Antes de publicar, confira pelo part number — é o único critério que não erra.",
      ...(a.veiculos.length >= MAX_VEICULOS
        ? {
            observacao: `Lista cortada em ${MAX_VEICULOS} veículos; provavelmente há mais.`,
          }
        : {}),
      fontes: [resultado.fonte!],
    };
  },
};
