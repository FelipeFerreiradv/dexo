import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";
import { OrderIngestionIssueService } from "./order-ingestion-issue.service";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_LIMIT = 50;
/** A partir daqui a pendência escala para logError: precisa de gente. */
const STUCK_AFTER_ATTEMPTS = 5;

/**
 * OrderIngestionReconcilerService
 *
 * Re-tenta as pendências de ingestão (`OrderIngestionIssue` com status OPEN e
 * `nextRetryAt` vencido) pelo caminho canônico de importação. É a metade que
 * transforma "registramos o problema" em "o problema se resolve sozinho quando
 * a causa some".
 *
 * Os dois casos que ele fecha na prática:
 *
 *  - `NO_LINKED_ITEMS` / `PARTIAL_LINK` / `PRODUCT_NOT_FOUND`: o cliente vincula
 *    o anúncio a um produto (ou cria o produto) e, na varredura seguinte, o
 *    pedido entra sozinho — com baixa — sem ninguém precisar rodar script.
 *  - `STOCK_DEDUCTION_FAILED`: o Order já existe; re-tentar a IMPORTAÇÃO é
 *    seguro porque ela cai em `already_exists`, então aqui re-tentamos a BAIXA
 *    diretamente. O net do StockLog por `reason` garante que nada baixa duas
 *    vezes, mesmo se a baixa original tiver acontecido parcialmente.
 *
 * Uma pendência que esgota as tentativas NUNCA vira estado terminal silencioso:
 * continua OPEN (e portanto visível na tela do cliente), só escala o SystemLog.
 *
 * Kill-switch: ORDER_INGESTION_RECONCILER_DISABLED=1 — checado no start (em
 * app/api/api.ts) e dentro do runOnce, para cobrir mudança de env em runtime.
 */
export class OrderIngestionReconcilerService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static running = false;
  private static runInProgress = false;
  /**
   * Pendências com re-tentativa em voo NESTE processo. O `runInProgress` protege
   * um tick contra o anterior, mas não protegia o tick contra o botão "Tentar
   * novamente" (`retryOne`), que é outro ponto de entrada sobre a MESMA
   * pendência. As duas execuções faziam a mesma varredura na API da Shopee.
   *
   * A corrupção de dados desse cruzamento já está fechada onde importa (a baixa
   * lê o net dentro da transação e o acréscimo de item é atômico); isto aqui
   * evita o desperdício de chamada e o contador de tentativas andando duas
   * vezes. Entre PROCESSOS pm2 distintos nada disto serializa — por isso a
   * proteção real tem que estar no banco, e está.
   */
  private static emAndamento = new Set<string>();

  static async runOnce(): Promise<void> {
    if (process.env.ORDER_INGESTION_RECONCILER_DISABLED === "1") return;
    // Com a quarentena desligada, `resolve()` vira no-op — o reconciliador
    // nunca conseguiria fechar nada e ficaria re-tentando as pendências
    // antigas para sempre. Os dois andam juntos.
    if (process.env.ORDER_INGESTION_ISSUES_DISABLED === "1") return;
    // Guarda de reentrância: um tick não pode começar com o anterior em voo,
    // senão dois workers pegam a mesma pendência.
    if (this.runInProgress) return;
    this.runInProgress = true;

    try {
      const pendentes = await (prisma as any).orderIngestionIssue.findMany({
        where: { status: "OPEN", nextRetryAt: { lte: new Date() } },
        orderBy: { nextRetryAt: "asc" },
        take: BATCH_LIMIT,
        include: {
          marketplaceAccount: {
            select: { id: true, platform: true, status: true, userId: true },
          },
        },
      });

      for (const issue of pendentes) {
        if (this.emAndamento.has(issue.id)) continue;
        this.emAndamento.add(issue.id);
        try {
          await this.retryIssue(issue);
        } catch (err) {
          // Uma pendência com problema não pode travar as demais.
          console.warn(
            `[OrderIngestionReconciler] Falha ao re-tentar #${issue.externalOrderId}:`,
            err instanceof Error ? err.message : err,
          );
          await this.registerFailure(
            issue,
            err instanceof Error ? err.message : String(err),
          );
        } finally {
          this.emAndamento.delete(issue.id);
        }
      }
    } catch (err) {
      console.error("[OrderIngestionReconciler] runOnce falhou:", err);
    } finally {
      this.runInProgress = false;
    }
  }

  /**
   * Re-tenta UMA pendência agora, sob demanda (botão "Tentar novamente" na tela
   * de Pedidos). Já vem escopada pelo tenant na rota. Devolve o estado da
   * pendência depois da tentativa, para a tela dizer se resolveu.
   */
  static async retryOne(issueId: string): Promise<{ resolved: boolean }> {
    // Os MESMOS dois kill-switches do runOnce. Sem eles, com a quarentena
    // desligada o `resolve()` é no-op: o botão bateria na API do marketplace,
    // baixaria estoque e ainda assim devolveria "não resolvido" para sempre —
    // a tela mentindo para o cliente a cada clique.
    if (process.env.ORDER_INGESTION_RECONCILER_DISABLED === "1") {
      return { resolved: false };
    }
    if (process.env.ORDER_INGESTION_ISSUES_DISABLED === "1") {
      return { resolved: false };
    }

    const issue = await (prisma as any).orderIngestionIssue.findUnique({
      where: { id: issueId },
      include: {
        marketplaceAccount: {
          select: { id: true, platform: true, status: true, userId: true },
        },
      },
    });

    if (!issue) return { resolved: false };

    // O botao vale para OPEN e para NEEDS_ACTION — este ultimo e exatamente o
    // caso de "cadastrei o produto, tenta agora".
    if (issue.status === "RESOLVED") return { resolved: true };

    // Já tem uma tentativa em voo neste processo (o tick do worker pegou a
    // mesma pendência): não duplica o trabalho.
    if (this.emAndamento.has(issue.id)) return { resolved: false };
    this.emAndamento.add(issue.id);

    try {
      await this.retryIssue(issue);
    } catch (err) {
      await this.registerFailure(
        issue,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.emAndamento.delete(issue.id);
    }

    const depois = await (prisma as any).orderIngestionIssue.findUnique({
      where: { id: issueId },
      select: { status: true },
    });
    return { resolved: depois?.status === "RESOLVED" };
  }

  private static async retryIssue(issue: any): Promise<void> {
    // Conta desconectada/quebrada: não adianta bater na API. Mantém OPEN (a
    // pendência continua visível) e adia.
    if (issue.marketplaceAccount?.status !== "ACTIVE") {
      await this.registerFailure(
        issue,
        `Conta ${issue.platform} nao esta ACTIVE (status: ${issue.marketplaceAccount?.status ?? "desconhecido"}).`,
      );
      return;
    }

    // Import tardio: order.usercase importa este módulo indiretamente e o
    // require circular no topo deixaria OrderUseCase undefined em runtime.
    const { OrderUseCase } = await import("../usecases/order.usercase");

    // Caso 1 — o pedido já existe e só faltou a baixa.
    if (issue.reason === "STOCK_DEDUCTION_FAILED" && issue.resolvedOrderId) {
      const resolvido = await (OrderUseCase as any).retryStockDeduction(
        issue.resolvedOrderId,
        issue.platform,
        issue.externalOrderId,
      );
      if (resolvido) {
        await OrderIngestionIssueService.resolve(
          issue.marketplaceAccountId,
          issue.externalOrderId,
          issue.resolvedOrderId,
        );
      } else {
        await this.registerFailure(
          issue,
          "Baixa ainda nao pode ser efetivada.",
        );
      }
      return;
    }

    // Caso 2 — reingerir o pedido pelo caminho canônico. Idempotente: se o
    // Order já existir, a importação devolve `already_exists`.
    if (issue.platform !== "SHOPEE") {
      // ML e Magalu não têm ingestão dirigida por `order_sn`, então não há como
      // re-buscar UM pedido. Mas quem resolve esses casos é o próprio poll: o
      // pedido não existe localmente, logo ele reaparece na janela a cada ciclo
      // e entra sozinho no momento em que o cliente cadastrar/vincular o
      // produto. O que falta é FECHAR a pendência quando isso acontece — e
      // fazer isso sem bater na API (auditoria 29/07/2026).
      const local = await (prisma as any).order.findFirst({
        where: {
          marketplaceAccountId: issue.marketplaceAccountId,
          externalOrderId: issue.externalOrderId,
        },
        select: { id: true, status: true, stockDeductedAt: true },
      });

      if (!local) {
        await this.registerFailure(
          issue,
          `Pedido ${issue.platform} ainda nao entrou; o poll tenta de novo a cada ciclo.`,
        );
        return;
      }

      if (local.status === "CANCELLED") {
        await OrderIngestionIssueService.resolve(
          issue.marketplaceAccountId,
          issue.externalOrderId,
          local.id,
        );
        return;
      }

      // Existe: falta garantir a baixa. Idempotente pelo net do StockLog, agora
      // lido dentro da transação.
      const { OrderUseCase: UC } = await import("../usecases/order.usercase");
      const baixou = await UC.retryStockDeduction(
        local.id,
        issue.platform,
        issue.externalOrderId,
      );

      if (baixou) {
        await OrderIngestionIssueService.resolve(
          issue.marketplaceAccountId,
          issue.externalOrderId,
          local.id,
        );
        return;
      }

      await this.registerFailure(
        issue,
        `Pedido ${issue.platform} existe (${local.id}) e a baixa segue pendente.`,
      );
      return;
    }

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      issue.marketplaceAccountId,
      1,
      true,
      { orderSns: [issue.externalOrderId] },
    );

    const entry = r.results.find(
      (x: any) => x.externalOrderId === issue.externalOrderId,
    );

    if (!entry) {
      await this.registerFailure(
        issue,
        "Pedido nao voltou da API do marketplace.",
      );
      return;
    }

    // Importado agora, completo e com baixa: resolvido pelo caminho normal.
    if (
      entry.status === "imported" &&
      entry.itemsLinked >= entry.itemsTotal &&
      entry.stockDeducted
    ) {
      await OrderIngestionIssueService.resolve(
        issue.marketplaceAccountId,
        issue.externalOrderId,
        entry.orderId ?? null,
      );
      return;
    }

    // O Order JA existia. Nao dá para julgar pelo resultado do import: o ramo
    // `already_exists` devolve itemsLinked=0 por construcao, entao qualquer
    // comparacao com itemsTotal daria "incompleto" para sempre. O veredito tem
    // que vir do estado REAL do pedido no banco.
    const local = await (prisma as any).order.findFirst({
      where: {
        marketplaceAccountId: issue.marketplaceAccountId,
        externalOrderId: issue.externalOrderId,
      },
      select: { id: true, status: true, items: { select: { id: true } } },
    });

    if (!local) {
      await this.registerFailure(
        issue,
        `Reingestao devolveu "${entry.status}" e o pedido nao existe localmente.`,
      );
      return;
    }

    // Pedido cancelado: nao ha venda a completar nem estoque a baixar.
    if (local.status === "CANCELLED") {
      await OrderIngestionIssueService.resolve(
        issue.marketplaceAccountId,
        issue.externalOrderId,
        local.id,
      );
      return;
    }

    const { OrderUseCase: UC } = await import("../usecases/order.usercase");

    // Se o cliente vinculou o produto que faltava, acrescenta o item agora —
    // re-importar sozinho nunca faria isso.
    let acrescentados = 0;
    const detalhe = issue.payload;
    if (detalhe?.item_list?.length && issue.marketplaceAccount?.userId) {
      acrescentados = await UC.completePartialShopeeOrder(
        issue.marketplaceAccountId,
        detalhe,
        local.id,
        issue.marketplaceAccount.userId,
      );
    }

    const itensEsperados = detalhe?.item_list?.length ?? 0;
    const itensAgora = local.items.length + acrescentados;

    // Baixa idempotente do que faltar (ancorada no net do StockLog).
    const baixou = await UC.retryStockDeduction(
      local.id,
      issue.platform,
      issue.externalOrderId,
    );

    if (baixou && itensEsperados > 0 && itensAgora >= itensEsperados) {
      await OrderIngestionIssueService.resolve(
        issue.marketplaceAccountId,
        issue.externalOrderId,
        local.id,
      );
      return;
    }

    await this.registerFailure(
      issue,
      `Pedido existe com ${itensAgora}/${itensEsperados} itens vinculados; baixa=${baixou ? "ok" : "pendente"}.`,
    );
  }

  /** attempts++, backoff exponencial, e escala o log quando empaca. */
  private static async registerFailure(
    issue: any,
    detail: string,
  ): Promise<void> {
    const attempts = (issue.attempts ?? 0) + 1;

    // Esgotou as tentativas num problema que a MAQUINA nao resolve? Sai da fila
    // automatica, mas NAO sai da tela.
    //
    // Medido em producao 30/07/2026: 166 pendencias abertas, 89 delas ja em
    // attempts>=5, todas NO_LINKED_ITEMS de produto que nao existe no Dexo. O
    // reconciliador seguia batendo na API da Shopee de hora em hora, para cada
    // uma, indefinidamente — e o aviso na tela do cliente nunca zerava, virando
    // ruido que treina a ignorar o banner.
    //
    // O invariante proibe estado terminal SILENCIOSO. `NEEDS_ACTION` nao e
    // silencioso: continua listado, com texto dizendo o que o cliente precisa
    // fazer, e o botao "Tentar novamente" segue funcionando. O que para e o
    // gasto de chamada externa com um problema que so acao humana fecha. E se o
    // cliente cadastrar o produto, o proprio poll importa o item e o `resolve()`
    // fecha a pendencia — sem depender do reconciliador.
    const soClienteResolve =
      process.env.ORDER_INGESTION_NEEDS_ACTION_DISABLED !== "1" &&
      attempts >= STUCK_AFTER_ATTEMPTS &&
      issue.reason === "NO_LINKED_ITEMS";

    try {
      await (prisma as any).orderIngestionIssue.update({
        where: { id: issue.id },
        data: {
          attempts,
          detail: detail.slice(0, 500),
          nextRetryAt: OrderIngestionIssueService.nextRetryFrom(attempts),
          // Nunca existe estado terminal de falha que faça a pendência sumir da
          // tela do cliente: OPEN continua sendo re-tentado, NEEDS_ACTION sai da
          // fila automática mas segue visível.
          status: soClienteResolve ? "NEEDS_ACTION" : "OPEN",
        },
      });
    } catch (err) {
      console.warn(
        `[OrderIngestionReconciler] Falha ao gravar tentativa de #${issue.externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (attempts === STUCK_AFTER_ATTEMPTS) {
      void SystemLogService.logError(
        "ORDER_INGESTION_ISSUE_STUCK",
        `Pendencia de importacao do pedido ${issue.platform} #${issue.externalOrderId} nao se resolve sozinha apos ${attempts} tentativas.`,
        {
          resource: "Order",
          resourceId: issue.externalOrderId,
          details: {
            platform: issue.platform,
            marketplaceAccountId: issue.marketplaceAccountId,
            reason: issue.reason,
            detail,
            attempts,
          },
        },
      ).catch(() => {});
    }
  }

  static start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error("[OrderIngestionReconciler] runOnce failed:", err);
      });
    }, intervalMs);
    console.log(
      `[OrderIngestionReconciler] started (interval=${intervalMs}ms)`,
    );
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
    this.runInProgress = false;
  }
}
