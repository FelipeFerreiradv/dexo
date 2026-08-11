// Tools de leitura de PRODUTOS.
//
// Ambas embrulham `ProductUseCase` — o MESMO caminho que a tela de Produtos
// usa. É o que garante o critério de aceite da fase: o número que o Bitz
// responde é o número que a tela mostra, porque é a mesma função.
//
// ⚠️ NOTA DE EFEITO COLATERAL, verificada no código:
// `ProductUseCase.listProducts` com `search` preenchido chama
// `ensureTextSearchExtensions` (product.repository.ts:1348 → :365), que roda
// `CREATE EXTENSION IF NOT EXISTS pg_trgm` e alguns `CREATE INDEX` — DDL, uma
// vez por processo, guardado por flag estática. NÃO é novo: é exatamente o que
// já acontece quando alguém digita na busca de Produtos, e na API de produção
// isso já rodou há muito tempo. Preferi o caminho da casa a escrever uma
// segunda busca "limpa" que divergiria da tela na primeira consulta.

import { z } from "zod";

import { ProductUseCase } from "../../../usecases/product.usercase";
import type { AiTool } from "../registry";
import { money, num, texto } from "../serialize";

/** Teto de itens por consulta. Sem isto, `limit` não tem máximo em camada nenhuma. */
const MAX_ITENS = 20;

/**
 * Projeção do produto para o modelo.
 *
 * ⭐ `costPrice` e `markup` VÊM no select do repositório
 * (product.repository.ts:429-430) e são cortados AQUI, explicitamente. Custo e
 * margem são informação interna da loja e não entram em contexto de IA em
 * hipótese nenhuma — `ai-privacy.spec.ts` prova que não saem.
 */
function projetarProduto(p: any) {
  return {
    id: p.id,
    sku: p.sku,
    nome: p.name,
    preco: money(p.price),
    estoque: num(p.stock),
    marca: p.brand ?? null,
    modelo: p.model ?? null,
    ano: p.year ?? null,
    versao: p.version ?? null,
    categoria: p.category ?? null,
    qualidade: p.quality ?? null,
    partNumber: p.partNumber ?? null,
    localizacao:
      p.locationPath ?? p.productLocation?.code ?? p.location ?? null,
    // ⚠️ CONSERTO DE UM DEFEITO PRÉ-EXISTENTE, achado ao estender o Bitz para
    // OLX e Facebook — e que valia para os CINCO canais, Mercado Livre
    // inclusive.
    //
    // `mapPrismaToProduct` (product.repository.ts:235-255) ACHATA o anúncio:
    // ele lê `marketplaceAccount.platform` e devolve `platform` no primeiro
    // nível, sem repassar o `marketplaceAccount`. A projeção aqui procurava
    // `l.marketplaceAccount?.platform`, que nesse objeto não existe — então
    // `plataforma` vinha `null` em toda peça, sempre, desde a Fase 5. O modelo
    // recebia "esta peça tem 2 anúncios" sem conseguir dizer ONDE.
    //
    // `conta` e `erro` saíram porque não é o caso de consertá-los: o select da
    // LISTAGEM (product.repository.ts:496-510) não busca `accountName` nem
    // `lastError`. Ir buscá-los aqui custaria egress em todo `buscar_produto`
    // para repetir o que `detalhe_produto` já entrega de graça, pelo `include`
    // que ele já faz. Campo que é sempre nulo não é informação: é token pago
    // para o modelo concluir que não há erro nenhum.
    anuncios: Array.isArray(p.listings)
      ? p.listings.map((l: any) => ({
          plataforma: l.platform ?? null,
          situacao: l.status ?? null,
        }))
      : [],
  };
}

export const buscarProduto: AiTool = {
  name: "buscar_produto",
  description:
    "Busca peças no catálogo da loja por nome, SKU, part number, marca ou modelo. " +
    "Entende abreviação de autopeça: 'fecha tras esq palio' encontra 'Fechadura Traseira Esquerda Palio'. " +
    "Buscar por um código (SKU, part number) faz busca exata — se não existir, o resultado é vazio, e isso é a resposta correta. " +
    "Devolve preço de venda, estoque, localização e, para cada anúncio, EM QUE CANAL ele está e a situação dele " +
    "(Mercado Livre, Shopee, Magalu, OLX e Facebook). NÃO devolve preço de custo nem margem.",
  args: z
    .object({
      consulta: z
        .string()
        .min(1)
        .max(120)
        .describe(
          "O que procurar: nome da peça, SKU, part number, marca+modelo.",
        ),
      limite: z
        .number()
        .int()
        .min(1)
        .max(MAX_ITENS)
        .optional()
        .describe(`Quantas peças trazer. Máximo ${MAX_ITENS}. Padrão 10.`),
      somenteComEstoque: z
        .boolean()
        .optional()
        .describe("true para trazer só peças com estoque disponível."),
    })
    .strict(),
  kind: "read",
  page: "produtos",
  keywords: [
    "peca",
    "produto",
    "sku",
    "part number",
    "catalogo",
    "estoque",
    "farol",
    "porta",
    "motor",
    "cambio",
    "lanterna",
    "parachoque",
    "retrovisor",
    "capo",
    "roda",
  ],
  sourceLabel: "Peças do seu catálogo",
  handler: async (args, scope) => {
    const limite = Math.min(args.limite ?? 10, MAX_ITENS);
    const usecase = new ProductUseCase();

    const { products, total } = await usecase.listProducts({
      userId: scope.dataOwnerId,
      search: args.consulta,
      limit: limite,
      page: 1,
      ...(args.somenteComEstoque ? { stockStatus: "IN_STOCK" as const } : {}),
    });

    return {
      total,
      exibidos: products.length,
      // Truncamento é dito em voz alta: "achei 3" quando existem 340 é uma
      // resposta errada com cara de certa.
      observacao:
        total > products.length
          ? `Existem ${total} peças no total; estas são as ${products.length} primeiras.`
          : undefined,
      itens: products.map(projetarProduto),
    };
  },
};

export const detalheProduto: AiTool = {
  name: "detalhe_produto",
  description:
    "Detalhe completo de UMA peça: dados, anúncios em cada marketplace (canal, conta e link), " +
    "últimas movimentações de estoque e o lote de sucata de origem. " +
    "NÃO traz o motivo de um anúncio recusado — isso vem de diagnostico_operacional. " +
    "Aceita o SKU ou o id. Use depois de buscar_produto, ou quando o usuário der o SKU direto.",
  args: z
    .object({
      sku: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe("SKU da peça, como aparece na etiqueta."),
      id: z.string().min(1).max(40).optional().describe("id interno da peça."),
    })
    .strict(),
  kind: "read",
  page: "produtos",
  keywords: ["detalhe", "ficha", "sku", "essa peca", "esse produto"],
  sourceLabel: "Ficha da peça",
  handler: async (args, scope) => {
    const usecase = new ProductUseCase();

    let id = args.id;
    if (!id) {
      if (!args.sku) {
        return { erro: "Informe o SKU ou o id da peça." };
      }
      // O SKU é resolvido pela MESMA busca da tela: um código cai no tier de
      // match exato, então não há risco de "adivinhar" outra peça.
      const { products } = await usecase.listProducts({
        userId: scope.dataOwnerId,
        search: args.sku,
        limit: 2,
        page: 1,
      });
      const exato = products.find(
        (p: any) =>
          String(p.sku).trim().toLowerCase() === args.sku!.trim().toLowerCase(),
      );
      if (!exato) {
        return {
          encontrado: false,
          observacao: `Nenhuma peça com o SKU "${args.sku}" nesta loja.`,
        };
      }
      id = exato.id;
    }

    const detalhe: any = await usecase.getDetail(id!, scope.dataOwnerId);
    if (!detalhe) return { encontrado: false };

    const p = detalhe.product ?? {};

    return {
      encontrado: true,
      produto: projetarProduto(p),
      descricao: texto(p.description, 400),
      medidas: {
        alturaCm: num(p.heightCm),
        larguraCm: num(p.widthCm),
        comprimentoCm: num(p.lengthCm),
        pesoKg: num(p.weightKg),
      },
      anuncios: (detalhe.detailedListings ?? []).map((l: any) => ({
        plataforma: l.platform,
        conta: l.accountName,
        situacao: l.status,
        link: l.permalink ?? null,
      })),
      movimentacoesRecentes: (detalhe.recentStockChanges ?? [])
        .slice(0, 10)
        .map((m: any) => ({
          quando: m.createdAt,
          variacao: num(m.change),
          de: num(m.previousStock),
          para: num(m.newStock),
          motivo: texto(m.reason, 120),
        })),
      // ⭐ Do lote vêm SÓ marca/modelo/ano. Placa e chassi estão no payload da
      // tela (product.repository.ts:1819-1831) e são cortados aqui: identificam
      // um veículo e não acrescentam nada a uma pergunta sobre a peça.
      sucataDeOrigem: detalhe.scrapSummary
        ? {
            id: detalhe.scrapSummary.id,
            veiculo: [
              detalhe.scrapSummary.brand,
              detalhe.scrapSummary.model,
              detalhe.scrapSummary.year,
            ]
              .filter(Boolean)
              .join(" "),
          }
        : null,
      // `creator` e `createdBy` do payload carregam E-MAIL. Só o nome sai.
      cadastradoPor: detalhe.createdBy?.name ?? null,
    };
  },
};
