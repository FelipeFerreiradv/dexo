// Tool de PENDÊNCIAS DO CATÁLOGO: "o que está incompleto ou parado?".
//
// É a irmã de `diagnostico_operacional`, e a divisão entre as duas é por
// PERMISSÃO, não por gosto:
//
//  - o diagnóstico responde "o que QUEBROU" (venda que não virou pedido,
//    anúncio recusado pelo canal, token caído) e mora em `page: "logs"`;
//  - esta responde "o que está INCOMPLETO" (peça sem anúncio, peça sem
//    localização, anúncio parado) e mora em `page: "produtos"`.
//
// ⚠️ Juntar as duas poria dado de catálogo atrás da permissão de logs. Quem
// libera "Produtos" para o balconista e esconde "Logs" espera exatamente que
// ele consiga perguntar quais peças estão sem anúncio.
//
// ⭐⭐ DUAS DAS TRÊS PERGUNTAS SÃO FILTRO QUE A TELA DE PRODUTOS JÁ TEM
// (`publicationStatus: "NO_LISTING"` e `"PAUSED"`), e por isso esta tool CHAMA
// O USECASE em vez de escrever consulta própria. Não é preguiça, é a regra da
// casa (tools/registry.ts:1-6): se o número que a tool devolve não é o mesmo
// que a tela mostra, a tool está errada.
//
// ⚠️⚠️ E aqui isso já evitou um defeito concreto: "pausado" no Dexo é
// `["paused", "unlist"]`, não só `"paused"` (PUBLICATION_STATUS_VALUES em
// product.repository.ts:69). Contei em produção: 5.699 linhas `paused` e 195
// `unlist`. Uma consulta própria com `status: "paused"` perderia as 195 em
// silêncio, e o Bitz daria um número menor que a tela — sem ninguém notar.
//
// ⭐ TODA RESPOSTA É CONTAGEM + AMOSTRA. O maior tenant deste sistema tem 79 mil
// peças; devolver a lista inteira seria pagar egress para o tool-runner truncar
// em 4.000 caracteres logo depois.

import { z } from "zod";

import prisma from "../../../lib/prisma";
import { ProductUseCase } from "../../../usecases/product.usercase";
import type { AiTool } from "../registry";
import { dataHora, money, num, texto } from "../serialize";

const MAX_LINHAS = 15;

const ESCOPOS = [
  "tudo",
  "sem-anuncio",
  "sem-localizacao",
  "anuncios-pausados",
] as const;

/**
 * Projeção ALLOWLIST, campo a campo.
 *
 * ⚠️ `listProducts` devolve o produto por `mapPrismaToProduct`, que inclui
 * `costPrice` e `markup` (product.repository.ts:270-271). Devolver o objeto —
 * ou um spread dele — mandaria custo e margem para o provedor de IA. A trava de
 * `CAMPOS_PROIBIDOS` no tool-runner pegaria e derrubaria a consulta inteira,
 * mas ela é a rede embaixo, não o plano: o plano é esta lista.
 */
function projetarPeca(p: any) {
  return {
    sku: p.sku ?? null,
    peca: texto(p.name, 80),
    preco: money(p.price),
    estoque: num(p.stock),
  };
}

export const pendenciasDoCatalogo: AiTool = {
  name: "pendencias_do_catalogo",
  description:
    "Lista o que está INCOMPLETO ou PARADO no catálogo: peças que não têm anúncio em canal nenhum, " +
    "peças sem localização definida (nem prateleira nem endereço em texto) e peças com anúncio pausado. " +
    "Use quando o usuário perguntar o que falta anunciar, o que está sem endereço no galpão ou o que está pausado. " +
    "Para anúncio RECUSADO pelo canal ou venda que não virou pedido, use diagnostico_operacional.",
  args: z
    .object({
      escopo: z
        .enum(ESCOPOS)
        .optional()
        .describe("O que investigar. Padrão 'tudo'."),
      limite: z
        .number()
        .int()
        .min(1)
        .max(MAX_LINHAS)
        .optional()
        .describe(
          `Quantas peças de exemplo trazer por bloco. Máximo ${MAX_LINHAS}. Padrão ${MAX_LINHAS}.`,
        ),
    })
    .strict(),
  kind: "read",
  page: "produtos",
  // ⚠️ Chaves sem acento e sem sobreposição por substring entre si. Tool de
  // LEITURA precisa de um ponto só, então elas podem (e devem) ser específicas:
  // uma chave solta como "anuncio" arrastaria esta tool para toda pergunta
  // sobre anúncio, inclusive "qual o preço desse anúncio".
  keywords: [
    "sem anuncio",
    "nao anunciad",
    "falta anuncia",
    "sem localizacao",
    "sem prateleira",
    "sem endereco",
    "pausad",
    "encalhad",
  ],
  sourceLabel: "Pendências do seu catálogo",
  handler: async (args, scope) => {
    const userId = scope.dataOwnerId;
    const escopo = args.escopo ?? "tudo";
    const limite = Math.min(args.limite ?? MAX_LINHAS, MAX_LINHAS);
    const usecase = new ProductUseCase();

    const quer = (alvo: string) => escopo === "tudo" || escopo === alvo;
    const resultado: Record<string, unknown> = {};

    // -----------------------------------------------------------------------
    // 1. Peças sem anúncio NENHUM.
    //
    // ⭐⭐ TRÊS NÚMEROS, E NÃO UM — este é o achado que mudou o desenho. Medindo
    // em produção, o maior tenant tem 77.480 peças sem anúncio de 79.452:
    // **97,5% do catálogo**. Devolver só "77.480" faria o Bitz anunciar uma
    // catástrofe onde existe uma escolha comercial — desmonte cadastra tudo que
    // tira do carro e anuncia o que vale a pena. Sem o denominador o número é
    // ininterpretável; sem o recorte de estoque ele é inacionável, porque peça
    // com estoque zero e sem anúncio não é oportunidade, é histórico.
    //
    // Custo medido em produção (79.452 peças): a contagem do anti-join leva
    // ~457 ms e a amostra ~0,15 ms. Sem Seq Scan — `Product(userId, createdAt)`
    // e `ProductListing(productId)` cobrem os dois lados.
    // -----------------------------------------------------------------------
    if (quer("sem-anuncio")) {
      const [semAnuncio, acionaveis, catalogo] = await Promise.all([
        usecase.listProducts({
          userId,
          publicationStatus: "NO_LISTING",
          page: 1,
          limit: 1,
        } as any),
        usecase.listProducts({
          userId,
          publicationStatus: "NO_LISTING",
          stockStatus: "IN_STOCK",
          page: 1,
          limit: limite,
        } as any),
        usecase.listProducts({ userId, page: 1, limit: 1 } as any),
      ]);

      resultado.pecasSemAnuncio = {
        total: semAnuncio.total,
        comEstoqueDisponivel: acionaveis.total,
        totalDePecasNoCatalogo: catalogo.total,
        significado:
          "Peças cadastradas no Dexo que não têm anúncio em canal nenhum. As que têm ESTOQUE são as que dá para anunciar hoje; as de estoque zero já saíram e não são oportunidade.",
        comoInterpretar:
          "Catálogo de desmonte tem muito mais peça cadastrada do que anunciada, e isso é NORMAL — compare com o total do catálogo antes de tratar como problema. O número que vira trabalho é o de peças COM estoque.",
        exibidas: acionaveis.products.length,
        oQueEstaNaAmostra:
          "As peças COM estoque e sem anúncio, das mais recentes para as mais antigas.",
        itens: acionaveis.products.map(projetarPeca),
      };
    }

    // -----------------------------------------------------------------------
    // 2. Peças sem localização.
    //
    // ⚠️ SÃO DOIS CAMPOS, e considerar só um daria meia verdade: `locationId`
    // é a prateleira cadastrada e `location` é o endereço em texto livre. A
    // definição sai da própria projeção da casa (read/produtos.ts:47-48), que
    // lê `locationPath ?? productLocation.code ?? location`: a peça só está
    // perdida quando os DOIS estão vazios.
    //
    // ⚠️ ESTA É A ÚNICA CONSULTA PRÓPRIA DA TOOL, e é porque
    // `ProductListFilters` não tem filtro de localização vazia — não há tela
    // equivalente de quem divergir. Fica em Prisma (e não `$queryRaw`) de
    // propósito: `ai-tenant-isolation.spec.ts` prova o isolamento inspecionando
    // `where.userId`, e SQL cru tiraria essa garantia do único teste que a tem.
    //
    // ⚠️ Limitação declarada: `location = "   "` (só espaços) não é pego.
    // Pegá-lo exigiria `btrim()` em SQL cru, e o preço acima é alto demais.
    // -----------------------------------------------------------------------
    if (quer("sem-localizacao")) {
      const filtro = {
        userId,
        locationId: null,
        OR: [{ location: null }, { location: "" }],
      };
      const [total, linhas] = await Promise.all([
        prisma.product.count({ where: filtro as any }),
        prisma.product.findMany({
          where: filtro as any,
          orderBy: { createdAt: "desc" },
          take: limite,
          // ⚠️ ALLOWLIST literal: `costPrice` e `markup` moram nesta tabela e
          // um `include` traria os dois. Aqui eles nem saem do banco.
          select: { sku: true, name: true, price: true, stock: true },
        }),
      ]);

      resultado.pecasSemLocalizacao = {
        total,
        exibidas: linhas.length,
        criterio:
          "Sem prateleira cadastrada E sem endereço em texto. Peça com qualquer um dos dois preenchidos NÃO entra nesta lista.",
        itens: linhas.map(projetarPeca),
      };
    }

    // -----------------------------------------------------------------------
    // 3. Peças com anúncio pausado.
    //
    // ⚠️ O TOTAL CONTA PEÇAS, NÃO ANÚNCIOS, e dizer isso é obrigatório: uma peça
    // pausada em três canais conta 1. Sem esta linha o Bitz responderia "você
    // tem 40 anúncios pausados" onde são 40 peças e até 120 anúncios.
    // -----------------------------------------------------------------------
    if (quer("anuncios-pausados")) {
      const { products, total } = await usecase.listProducts({
        userId,
        publicationStatus: "PAUSED",
        page: 1,
        limit: limite,
      } as any);

      resultado.pecasComAnuncioPausado = {
        total,
        aUnidadeEPeca:
          "Este total conta PEÇAS, não anúncios: uma peça pausada em três canais conta uma vez.",
        // ⚠️ HONESTIDADE SOBRE A DATA: não existe coluna "pausado desde". O que
        // existe é `updatedAt` do anúncio, que muda a cada escrita na linha —
        // inclusive atualização de métricas. Chamar isso de "pausado há X dias"
        // seria inventar uma precisão que o dado não tem, e o lojista decidiria
        // reativar em cima dela.
        atencao:
          "O sistema não guarda a data em que o anúncio foi pausado. A data abaixo é a da ÚLTIMA ALTERAÇÃO do anúncio, que é o mais próximo disso que existe.",
        exibidas: products.length,
        itens: products.map((p: any) => ({
          ...projetarPeca(p),
          // ⚠️ `mapPrismaToProduct` ACHATA o anúncio: `platform` vem no primeiro
          // nível e `marketplaceAccount` não é repassado. Ler
          // `l.marketplaceAccount?.platform` aqui daria `null` sempre — foi
          // exatamente o defeito consertado em `buscar_produto`.
          anunciosPausados: Array.isArray(p.listings)
            ? p.listings
                .filter((l: any) =>
                  ["paused", "unlist"].includes(
                    String(l?.status ?? "").toLowerCase(),
                  ),
                )
                .map((l: any) => ({
                  canal: l.platform ?? null,
                  ultimaAlteracao: dataHora(l.updatedAt),
                }))
            : [],
        })),
      };
    }

    return resultado;
  },
};
