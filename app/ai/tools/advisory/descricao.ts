// Tool consultiva: SUGERIR DESCRIÇÃO de anúncio.
//
// Dois degraus no mesmo nível `proprio`, e a ordem entre eles é a decisão do
// arquivo: o TEXTO PADRÃO que o lojista configurou vem antes das descrições que
// ele escreveu peça a peça. O padrão é a política declarada da loja (garantia,
// prazo, condição de entrega) — as descrições individuais são o que sobrou de
// copiar e colar. Empate de nível é permitido pela cadeia justamente para
// modelar preferência dentro da mesma fonte.
//
// Como em `titulo.ts`, as regras do canal ficam FORA da cadeia: são restrição,
// não alternativa. E a que mais importa não é o limite de caracteres — é que o
// Dexo JÁ ANEXA ficha técnica e SKU na publicação da Shopee. Sem saber disso, o
// lojista escreve marca/modelo/ano no texto livre e o anúncio sai com tudo
// duplicado.

import { z } from "zod";

import prisma from "../../../lib/prisma";
import {
  CANAIS,
  NOME_DO_CANAL,
  fonteDeRegra,
  regrasDeDescricao,
  type Canal,
} from "../../advisory/channel-rules";
import { buscarPecasParecidas } from "../../advisory/own-catalog";
import { resolverNaOrdem } from "../../advisory/source-chain";
import type { AiSource } from "../../core/types";
import type { AiTool } from "../registry";
import { texto } from "../serialize";

const MAX_EXEMPLOS = 3;

interface Base {
  textoPadrao: string | null;
  exemplos: string[];
  comoLer: string;
  estimativa: boolean;
}

export const sugerirDescricao: AiTool = {
  name: "sugerir_descricao",
  description:
    "Ajuda a escrever a descrição do anúncio. Devolve o texto padrão que esta loja configurou (se houver), descrições de peças parecidas dela, " +
    "e as regras do canal — inclusive o que o sistema já acrescenta sozinho na publicação e que portanto não deve ser repetido. " +
    "Quem redige a descrição final é você, a partir do que esta consulta devolver.",
  args: z
    .object({
      descricao: z
        .string()
        .min(3)
        .max(200)
        .describe("O que é a peça, do jeito que o usuário falou."),
      // ⭐ Vem de CANAIS, não de uma cópia literal. Eram três listas soltas em
      // três tools; um canal novo entrava em `channel-rules` e o modelo
      // continuava sem poder pedi-lo, sem erro nenhum aparecer.
      canal: z.enum(CANAIS).describe("Para qual marketplace."),
    })
    .strict(),
  kind: "advisory",
  page: "produtos",
  keywords: [
    "descricao",
    "descricoes",
    "texto do anuncio",
    "o que escrever",
    "descrever a peca",
    "olx",
    "facebook",
  ],
  sourceLabel: "Descrição padrão e exemplos da sua loja",
  handler: async (args, scope) => {
    const descricao = args.descricao.trim();
    const canal = args.canal as Canal;
    const regras = regrasDeDescricao(canal);

    const resultado = await resolverNaOrdem<Base>([
      {
        nivel: "proprio",
        buscar: async () => {
          // Uma coluna, da linha do próprio tenant. `dataOwnerId` é o dono da
          // conta — é lá que mora a configuração da loja, não no colaborador.
          const dono = await prisma.user.findUnique({
            where: { id: scope.dataOwnerId },
            select: { defaultProductDescription: true },
          });
          const padrao = texto(dono?.defaultProductDescription, 1200);
          if (!padrao) return null;
          return {
            valor: {
              textoPadrao: padrao,
              exemplos: [],
              comoLer:
                "Este é o texto padrão configurado por esta loja. Use-o como base e acrescente o que é específico da peça — não o reescreva.",
              estimativa: false,
            },
            fonte: {
              kind: "proprio",
              label: "Texto padrão configurado na sua loja",
              count: 1,
            } satisfies AiSource,
          };
        },
      },
      {
        nivel: "proprio",
        buscar: async () => {
          const pecas = await buscarPecasParecidas(scope, descricao);
          const textos = Array.from(
            new Set(
              pecas
                .map((p) => p.descricao)
                .filter((d): d is string => Boolean(d && d.length > 30)),
            ),
          ).slice(0, MAX_EXEMPLOS);
          if (textos.length === 0) return null;
          return {
            valor: {
              textoPadrao: null,
              exemplos: textos,
              comoLer:
                "São descrições que ESTA loja já escreveu para peças parecidas. Siga o tom e a estrutura delas.",
              estimativa: false,
            },
            fonte: {
              kind: "proprio",
              label: "Descrições de peças parecidas no seu catálogo",
              count: textos.length,
            } satisfies AiSource,
          };
        },
      },
      {
        nivel: "estimativa",
        buscar: async () => ({
          valor: {
            textoPadrao: null,
            exemplos: [],
            comoLer:
              "Esta loja não tem texto padrão configurado nem descrição de peça parecida. Escreva do zero, pelas regras do canal.",
            estimativa: true,
          },
          fonte: {
            kind: "estimativa",
            note: "Descrição redigida pelo Bitz — esta loja não tem texto padrão nem peça parecida para servir de referência.",
          } satisfies AiSource,
        }),
      },
    ]);

    const b = resultado.valor!;

    return {
      canal: NOME_DO_CANAL[canal],
      consultouNaOrdem: resultado.trilha.map((p) => p.nivel),
      ...(b.textoPadrao ? { textoPadraoDaLoja: b.textoPadrao } : {}),
      ...(b.exemplos.length > 0 ? { exemplosDaLoja: b.exemplos } : {}),
      comoLer: b.comoLer,
      regrasDoCanal: regras.map((x) => x.detalhe),
      atencao:
        "A descrição do anúncio não é o lugar de dado que muda: preço, estoque e prazo. Isso vive nos campos do anúncio e é sincronizado sozinho; escrito no texto, envelhece e vira reclamação.",
      ...(b.estimativa
        ? {
            instrucao:
              "DEIXE CLARO que o texto foi escrito por você e não veio de nada já cadastrado nesta loja. Sugira ao usuário salvar como texto padrão se gostar.",
          }
        : {}),
      ...(!b.textoPadrao
        ? {
            dica: "Esta loja pode configurar uma descrição padrão nas configurações — ela entra sozinha em todo produto novo.",
          }
        : {}),
      fontes: [resultado.fonte!, ...regras.map(fonteDeRegra)],
    };
  },
};
