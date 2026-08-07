// Tools de leitura de SUCATAS.
//
// A armadilha central deste domínio, e a razão de metade dos comentários aqui:
// os números da sucata vêm de TRÊS agregações com regras diferentes, e somá-las
// erradas é fácil.
//
//  - `realizedRevenue.counter` JÁ INCLUI as vendas de peça avulsa. O SQL do
//    balcão usa `COALESCE(ri.scrapId, p.scrapId)` com LEFT JOIN
//    (scrap.repository.ts:329-336), então o item manual sobrevive ao join.
//  - `manualSales` é a LISTA dessas mesmas vendas — conjunto disjunto de
//    `products`, existente só para o lojista ver de onde veio o dinheiro.
//
//  ⇒ SOMAR manualSales AO counter CONTA DUAS VEZES. A tela avisa isso ao
//    usuário (scrap-detail.tsx:739-742); aqui o aviso vai no payload, para o
//    modelo não refazer a conta.

import { z } from "zod";

import { ScrapUseCase } from "../../../usecases/scrap.usercase";
import type { AiTool } from "../registry";
import { data, money, num, texto } from "../serialize";

const MAX_ITENS = 20;
const MAX_PECAS = 30;

const STATUS = ["AVAILABLE", "IN_USE", "DEPLETED", "ARCHIVED"] as const;
const LOGISTICA = ["IN_TRANSIT", "IN_YARD", "ON_LIFT", "DISMANTLED"] as const;

const ROTULO_STATUS: Record<string, string> = {
  AVAILABLE: "Disponível",
  IN_USE: "Em uso",
  DEPLETED: "Esgotada",
  ARCHIVED: "Arquivada",
};

const ROTULO_LOGISTICA: Record<string, string> = {
  IN_TRANSIT: "Em Trânsito",
  IN_YARD: "No Pátio",
  ON_LIFT: "No Elevador",
  DISMANTLED: "Desmembrado",
};

function veiculo(s: any): string {
  return [s.brand, s.model, s.year, s.version].filter(Boolean).join(" ");
}

export const buscarSucata: AiTool = {
  name: "buscar_sucata",
  description:
    "Lista ou busca lotes de sucata (veículos arrematados) por marca, modelo, apelido, placa, chassi ou lote. " +
    "Devolve em que estágio do pátio o veículo está e a situação de estoque do lote. " +
    "Atenção: a busca é por campo inteiro — 'gol branco 2010' não encontra nada, porque nenhum campo contém a frase toda. " +
    "Busque por um termo de cada vez ('gol', a placa, o apelido).",
  args: z
    .object({
      consulta: z
        .string()
        .max(80)
        .optional()
        .describe(
          "Marca, modelo, apelido, placa, chassi ou lote. UM termo por vez.",
        ),
      situacao: z
        .enum(STATUS)
        .optional()
        .describe("Situação de estoque do lote."),
      estagioNoPatio: z
        .enum(LOGISTICA)
        .optional()
        .describe("Onde o veículo está no fluxo do pátio."),
      limite: z.number().int().min(1).max(MAX_ITENS).optional(),
    })
    .strict(),
  kind: "read",
  page: "sucatas",
  keywords: [
    "sucata",
    "lote",
    "veiculo",
    "veículo",
    "carro",
    "desmonte",
    "desmembr",
    "patio",
    "pátio",
    "placa",
    "chassi",
    "arremat",
    "leilao",
    "leilão",
  ],
  sourceLabel: "Sucatas da sua loja",
  handler: async (args, scope) => {
    const limite = Math.min(args.limite ?? 10, MAX_ITENS);
    const usecase = new ScrapUseCase();

    const { scraps, total } = await usecase.listScraps({
      userId: scope.dataOwnerId,
      ...(args.consulta ? { search: args.consulta } : {}),
      ...(args.situacao ? { status: args.situacao as any } : {}),
      ...(args.estagioNoPatio
        ? { logisticsStatus: args.estagioNoPatio as any }
        : {}),
      page: 1,
      limit: limite,
    });

    return {
      total,
      exibidos: scraps.length,
      observacao:
        total > scraps.length
          ? `Existem ${total} lotes no filtro; estes são os ${scraps.length} primeiros.`
          : undefined,
      itens: scraps.map((s: any) => ({
        id: s.id,
        veiculo: veiculo(s),
        apelido: s.nickname ?? null,
        placa: s.plate ?? null,
        lote: s.lot ?? null,
        situacaoDoEstoque: ROTULO_STATUS[s.status] ?? s.status,
        estagioNoPatio:
          ROTULO_LOGISTICA[s.logisticsStatus] ?? s.logisticsStatus,
        // O custo de compra do veículo vem em toda linha da listagem
        // (scrap.repository.ts:63-64, o `omit` não o corta). Aqui vira UM número
        // agregado, que é o que a tela chama de "Investimento" — em vez de
        // despejar arremate e extras separados de 20 veículos no contexto.
        investimento: money((num(s.cost) ?? 0) + (num(s.extraCosts) ?? 0)),
        pecasCadastradas: num(s.productsCount),
        cadastradoEm: data(s.createdAt),
      })),
    };
  },
};

export const detalheSucata: AiTool = {
  name: "detalhe_sucata",
  description:
    "Detalhe financeiro e de peças de UM lote de sucata: investimento, quanto já voltou em vendas, " +
    "retorno percentual, valor ainda parado em estoque, e a lista de peças. " +
    "Use depois de buscar_sucata para pegar o id.",
  args: z
    .object({
      id: z
        .string()
        .min(1)
        .max(40)
        .describe("id do lote, vindo de buscar_sucata."),
      incluirPecas: z
        .boolean()
        .optional()
        .describe("true para trazer também a lista de peças do lote."),
    })
    .strict(),
  kind: "read",
  page: "sucatas",
  keywords: [
    "quanto recuperei",
    "roi",
    "retorno",
    "investimento",
    "lote",
    "sucata",
  ],
  sourceLabel: "Financeiro do lote de sucata",
  handler: async (args, scope) => {
    const usecase = new ScrapUseCase();
    const detalhe: any = await usecase.getScrapDetail(
      args.id,
      scope.dataOwnerId,
      {
        financials: true,
        products: Boolean(args.incluirPecas),
        manualSales: true,
      },
    );

    if (!detalhe) return { encontrado: false };

    const f = detalhe.financials;
    const pecas = detalhe.products ?? [];

    return {
      encontrado: true,
      lote: {
        id: detalhe.id,
        veiculo: veiculo(detalhe),
        apelido: detalhe.nickname ?? null,
        placa: detalhe.plate ?? null,
        situacaoDoEstoque: ROTULO_STATUS[detalhe.status] ?? detalhe.status,
        estagioNoPatio:
          ROTULO_LOGISTICA[detalhe.logisticsStatus] ?? detalhe.logisticsStatus,
      },
      financeiro: f
        ? {
            investimento: money(f.investment),
            recuperado: {
              marketplaces: money(f.realizedRevenue?.marketplace),
              balcao: money(f.realizedRevenue?.counter),
              total: money(f.realizedRevenue?.total),
            },
            aindaEmEstoque: money(f.potentialRevenue),
            // Já vem multiplicado por 100 (scrap.usercase.ts:82-86): 25 = 25%.
            retornoPercentual: f.roi === null ? null : num(f.roi),
            resultado:
              f.investment > 0
                ? money((f.realizedRevenue?.total ?? 0) - f.investment)
                : null,
          }
        : null,
      regrasDoNumero: {
        investimento:
          "custo de arremate + custos extras. Não inclui ICMS nem frete do bloco fiscal.",
        recuperado:
          "receita BRUTA de vendas já efetivadas (pedido pago/enviado/entregue, ou conta de balcão PAGA). Não desconta comissão, frete nem imposto.",
        aindaEmEstoque:
          "preço de venda × quantidade das peças do lote que ainda têm estoque.",
        retornoPercentual:
          "(recuperado − investimento) ÷ investimento × 100. Não considera o que ainda está em estoque.",
        orcamentos: "orçamentos em aberto NÃO entram em nenhum destes números.",
      },
      vendasAvulsas: {
        // ⭐ O aviso que impede a contagem dupla.
        atencao:
          "Estas vendas JÁ ESTÃO somadas em recuperado.balcao. NUNCA some este total ao recuperado.",
        total: money(
          (detalhe.manualSales ?? []).reduce(
            (acc: number, m: any) => acc + (num(m.total) ?? 0),
            0,
          ),
        ),
        quantidade: (detalhe.manualSales ?? []).length,
      },
      pecas: args.incluirPecas
        ? {
            total: pecas.length,
            exibidas: Math.min(pecas.length, MAX_PECAS),
            observacao:
              pecas.length > MAX_PECAS
                ? `O lote tem ${pecas.length} peças; estas são as ${MAX_PECAS} primeiras.`
                : undefined,
            itens: pecas.slice(0, MAX_PECAS).map((p: any) => ({
              sku: p.sku,
              nome: texto(p.name, 80),
              preco: money(p.price),
              estoque: num(p.stock),
              // `status` da peça é derivado SÓ do estoque
              // (scrap.repository.ts:426): estoque 0 vira "SOLD" mesmo sem
              // venda nenhuma. Por isso devolvemos a quantidade vendida, que é
              // o único campo que prova venda.
              unidadesVendidas: num(p.soldQuantity),
            })),
          }
        : undefined,
    };
  },
};
