// Tools de ESCRITA de produto. Fase 9.
//
// ⭐ NENHUMA DELAS ESCREVE. Cada uma valida, resolve o alvo dentro do tenant,
// monta o resumo do que mudaria e grava uma PROPOSTA. Quem escreve é o clique
// do lojista em `POST /ai/acoes/:id/confirmar`.
//
// ⚠️ ALTERAR PRODUTO SINCRONIZA COM OS MARKETPLACES NA HORA.
// `ProductUseCase.update` dispara `syncProductData` para cada anúncio da peça
// (product.usercase.ts:1039-1063). Trocar o preço de uma peça anunciada muda o
// preço no Mercado Livre e na Shopee assim que for confirmado, e não há um
// clique para desfazer. Isso NÃO é contornado — usar um caminho que não
// sincroniza deixaria o Dexo dizendo um preço e o anúncio dizendo outro, que é
// pior. O que se faz é o lojista SABER: o `aviso` do cartão conta quantos
// anúncios serão afetados, e ele decide com essa informação na tela.

import { z } from "zod";

import { ProductUseCase } from "../../../usecases/product.usercase";
import { proporAcao } from "../../acoes/acao.service";
import {
  ACAO_EXIGE_PERMISSAO,
  type AiAcaoPreview,
} from "../../acoes/acao.types";
import type { AiScope } from "../../core/scope";
import type { AiTool, AiToolContext, AiWriteToolResult } from "../registry";
import { money } from "../serialize";

/** Teto de preço aceito. Não é regra fiscal: é rede contra dedo escorregado. */
const MAX_PRECO = 9_999_999;
/** Teto de estoque. Idem — 100 mil unidades da MESMA peça não existe num CDV. */
const MAX_ESTOQUE = 100_000;

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Acha a peça pelo SKU, DENTRO do tenant.
 *
 * ⭐ Por SKU e não por id: o id é interno e o modelo não tem como saber um sem
 * ter consultado antes. O SKU é o que o lojista fala em voz alta ("altera o
 * preço da 4821"), e é único por loja.
 *
 * Devolve `null` quando não acha — e "não achei" é a resposta correta, não um
 * convite para o modelo escolher a peça mais parecida.
 */
async function acharPorSku(sku: string, scope: AiScope) {
  const usecase = new ProductUseCase();
  const r = await usecase.listProducts({
    userId: scope.dataOwnerId,
    search: sku,
    limit: 10,
  } as any);

  const itens: any[] = Array.isArray(r) ? r : ((r as any)?.products ?? []);
  const alvo = sku.trim().toLowerCase();
  return itens.find((p) => String(p?.sku ?? "").toLowerCase() === alvo) ?? null;
}

/** Quantos anúncios a peça tem — é o que decide o aviso do cartão. */
function contarAnuncios(produto: any): number {
  return Array.isArray(produto?.listings) ? produto.listings.length : 0;
}

function avisoDeMarketplace(produto: any, oQueMuda: string): string | undefined {
  const n = contarAnuncios(produto);
  if (n === 0) return undefined;
  return (
    `⚠️ Esta peça tem ${n} anúncio${n > 1 ? "s" : ""} publicado${n > 1 ? "s" : ""}. ` +
    `Ao confirmar, ${oQueMuda} também ${n > 1 ? "serão atualizados" : "será atualizado"} ` +
    `no marketplace na hora — e isso não tem um clique para desfazer.`
  );
}

/**
 * ⚠️ A tool NUNCA devolve o produto. Só o que o modelo precisa para escrever
 * uma frase. Os campos vão para o cartão, que é renderizado no navegador a
 * partir da proposta gravada — sem passar pelo provedor de IA.
 */
const paraOModelo = (
  acaoId: string,
  frase: string,
): AiWriteToolResult["paraOModelo"] => ({
  proposta: "criada",
  acaoId,
  instrucao:
    `${frase} Diga ao usuário, em UMA frase, o que você preparou, e peça para ele CONFERIR E CONFIRMAR no cartão que apareceu. ` +
    `NÃO diga que já foi feito, NÃO diga que salvou, e NÃO prometa nada: nada foi alterado ainda. ` +
    `Se ele responder "sim" ou "confirma" por escrito, explique que a confirmação é o botão do cartão.`,
});

/**
 * ⭐ "NÃO ACHEI" É RESPOSTA, NÃO FALHA — e isto foi conserto de um achado.
 *
 * Antes a tool LANÇAVA quando o SKU não existia. O tool-runner traduz qualquer
 * exceção para "a consulta falhou, diga que não conseguiu buscar agora e que ele
 * pode tentar de novo" — então o lojista que digitou "9999" em vez de "4999"
 * ouvia "não consegui buscar agora", tentava de novo, ouvia a mesma coisa, e o
 * sistema NUNCA lhe dizia que o problema era o SKU. Um erro dele virava um erro
 * aparente nosso, sem saída.
 */
const naoAchei = (sku: string): AiWriteToolResult => ({
  acao: null,
  paraOModelo: {
    encontrado: false,
    sku,
    instrucao:
      `Não existe peça com o SKU "${sku}" no catálogo desta loja. Diga isso ao usuário em UMA frase, ` +
      "e ofereça buscar a peça pelo nome para descobrir o SKU certo. NÃO invente um SKU, " +
      "NÃO escolha uma peça parecida e NÃO diga que houve erro no sistema — não houve.",
  },
});

// ---------------------------------------------------------------------------

export const cadastrarProduto: AiTool = {
  name: "cadastrar_produto",
  description:
    "PREPARA o cadastro de uma peça nova no catálogo da loja. NÃO cadastra: devolve uma proposta que o usuário confirma na tela. " +
    "Use quando ele pedir para cadastrar, criar ou incluir uma peça. " +
    "O SKU é gerado automaticamente pelo sistema — não peça nem invente um.",
  args: z
    .object({
      nome: z
        .string()
        .min(2)
        .max(120)
        .describe("Nome da peça, como aparece no catálogo."),
      preco: z
        .number()
        .min(0)
        .max(MAX_PRECO)
        .describe("Preço de VENDA em reais. Nunca o preço de custo."),
      estoque: z
        .number()
        .int()
        .min(0)
        .max(MAX_ESTOQUE)
        .describe("Quantidade em estoque."),
      marca: z.string().max(60).optional(),
      modelo: z.string().max(60).optional(),
      ano: z.string().max(20).optional(),
      categoria: z.string().max(60).optional(),
      partNumber: z
        .string()
        .max(60)
        .optional()
        .describe("Código do fabricante (OEM), se o usuário informou."),
    })
    .strict(),
  kind: "write",
  page: "produtos",
  action: ACAO_EXIGE_PERMISSAO["produto.criar"],
  // ⭐ PALAVRAS SOLTAS, e é seguro porque tool de escrita exige DOIS sinais
  // (ver MIN_PONTOS_ESCRITA em select.ts). Verbo + objeto: "cadastra essa peca"
  // dá 2 e entra; "cadastro de cliente sumiu" dá 1 aqui e fica de fora.
  //
  // ⚠️ Pares como "criar produto" eram linha morta: qualquer palavra no meio
  // ("cria um produto") quebrava o casamento, em silêncio.
  keywords: [
    "cadastr",
    "cria",
    "criar",
    "inclui",
    "adicion",
    "nova",
    "novo",
    "peca",
    "produto",
    "item",
  ],
  sourceLabel: "Cadastro de peça",
  async handler(args, scope, ctx?: AiToolContext) {
    const campos = [
      { campo: "Nome", para: args.nome },
      { campo: "Preço de venda", para: brl(args.preco) },
      { campo: "Estoque", para: String(args.estoque) },
      ...(args.marca ? [{ campo: "Marca", para: args.marca }] : []),
      ...(args.modelo ? [{ campo: "Modelo", para: args.modelo }] : []),
      ...(args.ano ? [{ campo: "Ano", para: args.ano }] : []),
      ...(args.categoria ? [{ campo: "Categoria", para: args.categoria }] : []),
      ...(args.partNumber
        ? [{ campo: "Part number", para: args.partNumber }]
        : []),
    ];

    const preview: AiAcaoPreview = {
      titulo: "Cadastrar peça",
      alvo: args.nome,
      campos,
      aviso:
        "O SKU é gerado pelo sistema no momento da confirmação. A peça nasce SEM anúncio: publicar continua sendo um passo seu, na tela de anúncios.",
    };

    const acao = await proporAcao({
      scope,
      tipo: "produto.criar",
      payload: {
        produto: {
          name: args.nome,
          price: args.preco,
          stock: args.estoque,
          brand: args.marca ?? null,
          model: args.modelo ?? null,
          year: args.ano ?? null,
          category: args.categoria ?? null,
          partNumber: args.partNumber ?? null,
        },
      },
      preview,
      conversationId: ctx?.conversationId,
    });

    return {
      acao,
      paraOModelo: paraOModelo(acao.id, "Preparei o cadastro da peça."),
    };
  },
};

// ---------------------------------------------------------------------------

export const alterarPrecoDoProduto: AiTool = {
  name: "alterar_preco_produto",
  description:
    "PREPARA a troca do preço de VENDA de uma peça já cadastrada, identificada pelo SKU. NÃO altera: devolve uma proposta que o usuário confirma na tela. " +
    "Se a peça tiver anúncio publicado, o preço muda no marketplace assim que ele confirmar — o cartão avisa isso. " +
    "Se você não souber o SKU, busque a peça antes e pergunte ao usuário qual é a certa.",
  args: z
    .object({
      sku: z.string().min(1).max(60).describe("SKU exato da peça."),
      preco: z
        .number()
        .min(0)
        .max(MAX_PRECO)
        .describe("Novo preço de VENDA em reais."),
    })
    .strict(),
  kind: "write",
  page: "produtos",
  action: ACAO_EXIGE_PERMISSAO["produto.preco"],
  keywords: [
    "altera",
    "muda",
    "troca",
    "atualiz",
    "reajust",
    "corrig",
    "poe",
    "bota",
    "coloca",
    "preco",
    "valor",
  ],
  sourceLabel: "Alteração de preço",
  async handler(args, scope, ctx?: AiToolContext) {
    const produto = await acharPorSku(args.sku, scope);
    if (!produto) return naoAchei(args.sku);

    const de = Number(produto.price ?? 0);
    const preview: AiAcaoPreview = {
      titulo: "Alterar preço",
      alvo: `${produto.name} (SKU ${produto.sku})`,
      campos: [
        { campo: "Preço de venda", de: brl(de), para: brl(args.preco) },
      ],
      aviso: avisoDeMarketplace(produto, "o preço dos anúncios"),
    };

    const acao = await proporAcao({
      scope,
      tipo: "produto.preco",
      // O ID resolvido AQUI, dentro do tenant. O cliente devolve só o id da
      // proposta; o alvo já está travado.
      payload: { produtoId: produto.id, preco: args.preco, precoAnterior: de },
      preview,
      conversationId: ctx?.conversationId,
    });

    return {
      acao,
      paraOModelo: paraOModelo(
        acao.id,
        `Preparei a troca de preço de ${money(de)} para ${money(args.preco)}.`,
      ),
    };
  },
};

// ---------------------------------------------------------------------------

export const ajustarEstoqueDoProduto: AiTool = {
  name: "ajustar_estoque_produto",
  description:
    "PREPARA a correção da quantidade em estoque de uma peça, identificada pelo SKU. NÃO altera: devolve uma proposta que o usuário confirma na tela. " +
    "O valor é a quantidade FINAL, não a diferença. " +
    "Se a peça tiver anúncio publicado, o estoque muda no marketplace assim que ele confirmar.",
  args: z
    .object({
      sku: z.string().min(1).max(60).describe("SKU exato da peça."),
      estoque: z
        .number()
        .int()
        .min(0)
        .max(MAX_ESTOQUE)
        .describe("Quantidade FINAL em estoque, não a diferença."),
    })
    .strict(),
  kind: "write",
  page: "produtos",
  action: ACAO_EXIGE_PERMISSAO["produto.estoque"],
  keywords: [
    "ajust",
    "corrig",
    "altera",
    "muda",
    "atualiz",
    "dar baixa",
    "entrou",
    "chegou",
    "sobrou",
    "estoque",
    "quantidade",
    "unidades",
  ],
  sourceLabel: "Ajuste de estoque",
  async handler(args, scope, ctx?: AiToolContext) {
    const produto = await acharPorSku(args.sku, scope);
    if (!produto) return naoAchei(args.sku);

    const de = Number(produto.stock ?? 0);
    const preview: AiAcaoPreview = {
      titulo: "Ajustar estoque",
      alvo: `${produto.name} (SKU ${produto.sku})`,
      campos: [{ campo: "Estoque", de: String(de), para: String(args.estoque) }],
      aviso:
        avisoDeMarketplace(produto, "a quantidade dos anúncios") ??
        (args.estoque === 0
          ? "Estoque zero deixa a peça indisponível para venda."
          : undefined),
    };

    const acao = await proporAcao({
      scope,
      tipo: "produto.estoque",
      payload: {
        produtoId: produto.id,
        estoque: args.estoque,
        estoqueAnterior: de,
      },
      preview,
      conversationId: ctx?.conversationId,
    });

    return {
      acao,
      paraOModelo: paraOModelo(
        acao.id,
        `Preparei o ajuste de estoque de ${de} para ${args.estoque}.`,
      ),
    };
  },
};
