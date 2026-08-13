// Tool de ESCRITA de ANÚNCIO: pausar e reativar.
//
// ⭐ NÃO EXECUTA. Como todas as outras, ela para na proposta; quem muda o
// anúncio no canal é o clique do lojista.
//
// ⚠️⚠️ A OLX NÃO ENTRA NO PAUSAR, E ISSO NÃO É ESQUECIMENTO.
// Lá "pausar" não existe: `updateListingStatus` chama `OlxApiService.deleteAd`
// (listing.usercase.ts:5910) e o anúncio é DESTRUÍDO — republicar cria um novo,
// com outro endereço e sem as visualizações acumuladas. A regra do dono é que o
// Bitz não apaga nada, e ela vale aqui: a tool pausa nos outros quatro canais e
// manda a pessoa fazer a OLX na tela, onde ela vê o que está fazendo.
//
// ⭐ O QUE ELA NÃO FAZ, e é decisão de escopo: PUBLICAR. Publicar exige
// categoria, título, descrição, fotos e conta de destino — as decisões que o
// assistente de cadastro toma em vários passos. Fazer isso por chat seria pedir
// ao lojista para confirmar às cegas um anúncio que ele não viu.

import { z } from "zod";

import { Platform } from "@prisma/client";

import { ProductUseCase } from "../../../usecases/product.usercase";
import { proporAcao } from "../../acoes/acao.service";
import {
  ACAO_EXIGE_PERMISSAO,
  type AiAcaoPreview,
} from "../../acoes/acao.types";
import type { AiScope } from "../../core/scope";
import type { AiTool, AiToolContext, AiWriteToolResult } from "../registry";

/** Nome de canal como o lojista fala. */
const NOME_DO_CANAL: Record<string, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
  OLX: "OLX",
  FACEBOOK: "Facebook",
};

const nomeDoCanal = (p: unknown) =>
  NOME_DO_CANAL[String(p ?? "")] ?? String(p ?? "canal desconhecido");

/** Resposta de negócio: nada foi proposto. */
function semProposta(instrucao: string): AiWriteToolResult {
  return { acao: null, paraOModelo: { proposta: "nao_aplicavel", instrucao } };
}

/** Acha a peça pelo SKU, DENTRO do tenant. */
async function acharPorSku(sku: string, scope: AiScope) {
  const usecase = new ProductUseCase();
  const r: any = await usecase.listProducts({
    userId: scope.dataOwnerId,
    search: sku,
    limit: 10,
  } as any);
  const itens: any[] = Array.isArray(r) ? r : (r?.products ?? []);
  const alvo = sku.trim().toLowerCase();
  return itens.find((p) => String(p?.sku ?? "").toLowerCase() === alvo) ?? null;
}

/** Anúncios já publicados (os `PENDING_` ainda nem existem no canal). */
function anunciosPublicados(produto: any): any[] {
  return (Array.isArray(produto?.listings) ? produto.listings : []).filter(
    (l: any) =>
      l?.externalListingId &&
      !String(l.externalListingId).startsWith("PENDING_"),
  );
}

export const pausarOuReativarAnuncio: AiTool = {
  name: "pausar_ou_reativar_anuncio",
  description:
    "PREPARA a pausa ou a reativação dos anúncios de uma peça. NÃO altera nada agora: devolve uma proposta que o usuário confirma na tela. " +
    "Use quando ele pedir para tirar do ar, pausar, suspender, reativar ou colocar de volta no ar. " +
    "Precisa do SKU da peça. " +
    "NÃO publica anúncio novo — publicar se faz na tela de Produtos, onde dá para escolher categoria, título e fotos.",
  args: z
    .object({
      sku: z
        .string()
        .min(1)
        .max(40)
        .describe("SKU da peça, como o usuário falou. Não invente."),
      situacao: z
        .enum(["pausado", "ativo"])
        .describe(
          "'pausado' tira do ar; 'ativo' coloca de volta no ar.",
        ),
    })
    .strict(),
  kind: "write",
  page: "produtos",
  action: ACAO_EXIGE_PERMISSAO["anuncio.situacao"],
  // ⚠️⚠️ `pausa` SOZINHO NÃO PODE ENTRAR, e este é o achado que quase passou:
  // ele casa "anuncios PAUSADOS" por substring, e "me mostra os anuncios
  // pausados" — que está pinada em `ai-write-turn.spec.ts` como consulta PURA —
  // somava `pausa` + `anuncio` = 2 pontos e passava a oferecer uma tool que
  // propõe TIRAR A PEÇA DO AR. Errar mostrando um número é recuperável; errar
  // propondo tirar do ar assusta o lojista.
  //
  // `pausa o` resolve: casa "pausa o anuncio" e "pausa os anuncios" (substring),
  // e NÃO casa "anuncios pausados".
  keywords: [
    "pausar",
    "pausa o",
    "reativ",
    "suspend",
    "despublic",
    "tira do ar",
    "de volta no ar",
    "anuncio",
  ],
  sourceLabel: "Situação dos anúncios",
  async handler(
    args,
    scope,
    ctx?: AiToolContext,
  ): Promise<AiWriteToolResult> {
    const produto = await acharPorSku(args.sku, scope);
    if (!produto) {
      return semProposta(
        `Não existe peça com o SKU ${args.sku} no catálogo desta loja. ` +
          "Diga isso ao usuário, com o SKU que ele passou. NÃO invente uma peça.",
      );
    }

    const publicados = anunciosPublicados(produto);
    if (publicados.length === 0) {
      return semProposta(
        `A peça ${args.sku} não tem anúncio publicado em canal nenhum, então não há o que pausar nem reativar. ` +
          "Diga isso ao usuário. Publicar um anúncio novo se faz na tela de Produtos.",
      );
    }

    const pausando = args.situacao === "pausado";

    // ⚠️ A OLX sai fora do PAUSAR — e só do pausar. Reativar lá é recriar o
    // anúncio, o que é construtivo; pausar é destruir.
    const naOlx = publicados.filter(
      (l: any) => l.platform === Platform.OLX,
    );
    const afetados = pausando
      ? publicados.filter((l: any) => l.platform !== Platform.OLX)
      : publicados;

    if (afetados.length === 0) {
      // Só havia OLX, e ele pediu para pausar: não há operação segura.
      return semProposta(
        `Os anúncios da peça ${args.sku} estão só na OLX, e lá pausar significa EXCLUIR o anúncio — ` +
          "republicar depois cria um anúncio novo, com outro endereço e sem as visualizações. " +
          "Por isso eu não faço isso por aqui. Diga ao usuário que, se for mesmo o que ele quer, " +
          "ele faz na tela de Anúncios. NÃO ofereça outro caminho.",
      );
    }

    const canais = afetados.map((l: any) => nomeDoCanal(l.platform));
    const verbo = pausando ? "Pausar" : "Reativar";

    const avisos = [
      pausando
        ? `Isto tira a peça do ar em ${canais.length === 1 ? "1 canal" : `${canais.length} canais`} AGORA, e não existe um clique para desfazer — reativar é outra operação.`
        : `Isto coloca a peça de volta no ar em ${canais.length === 1 ? "1 canal" : `${canais.length} canais`} AGORA.`,
      // ⭐ O aviso da OLX só aparece quando há OLX. Avisar sobre um canal que a
      // loja não usa é ruído que ensina a ignorar aviso.
      pausando && naOlx.length > 0
        ? "⚠️ O anúncio da OLX NÃO será tocado: lá pausar significa excluir, e republicar cria um anúncio novo (perde endereço e visualizações). Se quiser mesmo tirar da OLX, faça na tela de Anúncios."
        : undefined,
      !pausando && naOlx.length > 0
        ? "⚠️ Na OLX, reativar RECRIA o anúncio do zero e ele volta para a fila de revisão — o endereço e as visualizações antigas não voltam."
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    const preview: AiAcaoPreview = {
      titulo: `${verbo} anúncios`,
      alvo: `${produto.name ?? "peça"} (SKU ${produto.sku})`,
      campos: [
        {
          campo: "Situação",
          de: pausando ? "no ar" : "fora do ar",
          para: pausando ? "fora do ar" : "no ar",
        },
        { campo: "Canais afetados", para: canais.join(", ") },
      ],
      aviso: avisos,
    };

    const acao = await proporAcao({
      scope,
      tipo: "anuncio.situacao",
      payload: {
        produtoId: produto.id,
        situacao: pausando ? "paused" : "active",
        // O executor repete a exclusão a partir do payload — nunca recalcula a
        // partir do estado de agora, que pode ter mudado em 30 minutos.
        pularOlx: pausando,
      },
      preview,
      conversationId: ctx?.conversationId,
    });

    return {
      acao,
      paraOModelo: {
        proposta: "criada",
        acaoId: acao.id,
        canais,
        instrucao:
          `Preparei a ${pausando ? "pausa" : "reativação"} dos anúncios. Diga ao usuário, em UMA frase, em QUE CANAIS isso vai valer, e peça para ele CONFERIR E CONFIRMAR no cartão. ` +
          "NÃO diga que já foi feito. " +
          (pausando && naOlx.length > 0
            ? "MENCIONE que a OLX ficou de fora e por quê (lá pausar exclui o anúncio). "
            : "") +
          'Se ele responder "sim" por escrito, explique que a confirmação é o botão do cartão.',
      },
    };
  },
};
