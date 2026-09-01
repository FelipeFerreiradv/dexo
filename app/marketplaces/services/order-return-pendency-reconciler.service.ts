import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";
import { MLApiService } from "./ml-api.service";
import { MLOAuthService } from "./ml-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { OrderOutcomeService } from "./order-outcome.service";
import { OrderReturnPendencyService } from "./order-return-pendency.service";
import { OrderUseCase } from "../usecases/order.usercase";

/**
 * Reconsulta o marketplace para ver se o desfecho de uma devolução MUDOU.
 *
 * Duas coisas que ele faz, e uma que ele NUNCA faz:
 *
 *  - fecha a pendência quando o marketplace desfaz a devolução e mantém a
 *    venda (o pedido volta a `paid`, o dinheiro fica com o vendedor) — e, se o
 *    estoque já tinha voltado por um cancelamento anterior, manda re-baixar
 *    pelo net do StockLog, nunca duas vezes;
 *  - atualiza o texto da pendência quando o envio passa a registrar a
 *    devolução como concluída, para o operador ver "o ML confirma que voltou".
 *
 *  - NUNCA repõe estoque. A peça só volta ao estoque quando uma pessoa
 *    confirma que ela está na prateleira (decisão do dono, 01/09/2026). Este
 *    serviço só muda o que o operador VÊ, e o desfecho quando a venda é
 *    mantida — que não cria estoque, só o mantém baixado.
 *
 * Cadência de 30 min e backoff até 6 h: o desfecho de uma devolução muda em
 * dias, não em minutos. Bater de minuto em minuto seria queimar chamada de API
 * de graça.
 *
 * Kill-switch: ORDER_RETURN_RECONCILER_DISABLED=1.
 */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const BATCH_LIMIT = 25;
/**
 * A partir daqui a pendência vira `NEEDS_ACTION` e SAI da fila automática de
 * verdade — a varredura acima filtra `status: "OPEN"`. Ela continua na tela,
 * porque a rota lista `OPEN` e `NEEDS_ACTION`.
 */
const STUCK_AFTER_ATTEMPTS = 8;

export class OrderReturnPendencyReconcilerService {
  private static running = false;
  private static runInProgress = false;
  private static intervalId: NodeJS.Timeout | null = null;

  static async runOnce(): Promise<{ processadas: number; fechadas: number }> {
    if (process.env.ORDER_RETURN_RECONCILER_DISABLED === "1") {
      return { processadas: 0, fechadas: 0 };
    }
    // Guarda tick-vs-tick. Entre processos pm2 nada disso serializa — a
    // proteção real é o claim atômico no banco, dentro de cada resolução.
    if (this.runInProgress) return { processadas: 0, fechadas: 0 };
    this.runInProgress = true;

    let processadas = 0;
    let fechadas = 0;
    try {
      const pendentes = await (prisma as any).orderReturnPendency.findMany({
        where: {
          // Só `OPEN`, como o irmão (order-ingestion-reconciler:64). Incluir
          // `NEEDS_ACTION` aqui contradiria o próprio nome do estado: ela
          // continua NA TELA (a rota filtra os dois), mas sai da fila
          // automática — senão uma pendência encalhada volta a ser consultada
          // 4x por dia para sempre, que é o incidente já documentado em
          // vitest.config.ts ("89 pendencias irresolviveis seguem batendo na
          // API da Shopee para sempre").
          status: "OPEN",
          // Só o ML tem pós-venda legível: `revisarPendencia` devolve `false`
          // incondicionalmente para as outras plataformas. Sem este filtro,
          // toda pendência Shopee/Magalu seria um no-op GARANTIDO que ainda
          // assim consome slot do lote e gasta 1 UPDATE por visita —
          // deslocando justamente as pendências ML, que são as únicas com
          // trabalho a fazer. Com `take: 25` e backoff de 6h o sistema
          // saturaria em ~300 pendências e as novas nunca seriam alcançadas.
          platform: "MERCADO_LIVRE",
          nextRetryAt: { lte: new Date() },
        },
        orderBy: { nextRetryAt: "asc" },
        take: BATCH_LIMIT,
        // Seleção explícita (regra de egress nº 1): `include` puro traria
        // `payload` e `detail` — a evidência em JSON — que este caminho nunca
        // lê. São 1.200 leituras/dia.
        select: {
          id: true,
          externalOrderId: true,
          reason: true,
          attempts: true,
          marketplaceAccount: {
            select: { id: true, platform: true, status: true, userId: true },
          },
        },
      });

      for (const p of pendentes) {
        processadas++;
        try {
          const mudou = await this.revisarPendencia(p);
          if (mudou) fechadas++;
          else await this.registrarTentativa(p);
        } catch (err) {
          console.error(
            `[OrderReturnPendencyReconciler] Falha ao revisar #${p.externalOrderId}:`,
            err instanceof Error ? err.message : err,
          );
          await this.registrarTentativa(p);
        }
      }
    } finally {
      this.runInProgress = false;
    }

    return { processadas, fechadas };
  }

  /**
   * Devolve `true` quando a pendência foi FECHADA nesta passada.
   *
   * Só o ML é reconsultado hoje: é a única plataforma cujo pós-venda o sistema
   * sabe ler (`GET /orders/{id}` + `GET /shipments/{id}`). Shopee e Magalu
   * ficam esperando decisão humana — que é o comportamento seguro, e não uma
   * lacuna disfarçada de feature.
   */
  private static async revisarPendencia(p: any): Promise<boolean> {
    const conta = p.marketplaceAccount;
    if (!conta || conta.status !== "ACTIVE") return false;
    if (conta.platform !== "MERCADO_LIVRE") return false;

    const fresh = await prisma.marketplaceAccount.findUnique({
      where: { id: conta.id },
      select: {
        id: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
      },
    });
    if (!fresh) return false;

    let accessToken = fresh.accessToken;
    if (fresh.expiresAt && fresh.expiresAt < new Date() && fresh.refreshToken) {
      const r = await MLOAuthService.refreshAccessToken(fresh.refreshToken);
      await MarketplaceRepository.updateTokens(fresh.id, {
        accessToken: r.accessToken,
        refreshToken: r.refreshToken,
        expiresAt: new Date(Date.now() + r.expiresIn * 1000),
      });
      accessToken = r.accessToken;
    }

    const mlOrder = await MLApiService.getOrderDetails(
      accessToken,
      p.externalOrderId,
    );

    // ── O marketplace desfez a devolução e manteve a venda ────────────────
    // O pedido voltou a ser venda concretizada. O estoque NÃO volta; e se ele
    // já tinha voltado (cancelamento anterior que estornou), a re-dedução vai
    // pelo net do StockLog, que nunca baixa duas vezes.
    if (mlOrder.status === "paid" || mlOrder.status === "partially_refunded") {
      const local = await prisma.order.findFirst({
        where: {
          marketplaceAccountId: conta.id,
          externalOrderId: p.externalOrderId,
        },
        select: { id: true, status: true },
      });
      if (local?.status === "CANCELLED") {
        await OrderUseCase.processOrderUncancellation({
          marketplaceAccountId: conta.id,
          externalOrderId: p.externalOrderId,
          platformLabel: "ML",
          targetStatus: "PAID",
          logPrefix: "[OrderReturnPendencyReconciler]",
        });
      }
      const fechou = await OrderReturnPendencyService.resolve(
        conta.id,
        p.externalOrderId,
        "VENDA_MANTIDA",
        null,
      );
      if (fechou) {
        void SystemLogService.logInfo(
          "ORDER_RETURN_SALE_REINSTATED",
          `Pedido ML #${p.externalOrderId}: o Mercado Livre desfez a devolução e manteve a venda — estoque permanece baixado.`,
          {
            resource: "Order",
            resourceId: p.externalOrderId,
            details: {
              marketplaceAccountId: conta.id,
              externalOrderId: p.externalOrderId,
              mlStatus: mlOrder.status,
            },
          },
        ).catch(() => {});
      }
      return fechou;
    }

    // ── Continua devolvido: só atualiza o que o operador vê ───────────────
    const shipmentId = mlOrder.shipping?.id ?? null;
    const shipment = shipmentId
      ? await MLApiService.getShipmentDetails(accessToken, shipmentId)
      : null;
    const desfecho = OrderOutcomeService.classificarML(mlOrder, shipment);

    // `open` é upsert e não rebaixa NEEDS_ACTION: reaproveitá-lo aqui mantém
    // uma única porta de escrita da pendência.
    if (desfecho.reterEstorno && desfecho.reason !== p.reason) {
      await OrderReturnPendencyService.open({
        marketplaceAccountId: conta.id,
        platform: "MERCADO_LIVRE",
        externalOrderId: p.externalOrderId,
        reason: desfecho.reason ?? "PECA_EM_TRANSITO",
        detail: desfecho.detail,
        evidencia: { ...desfecho.evidencia, desfecho: desfecho.peca },
      });
    }
    return false;
  }

  /** Backoff + escalada para NEEDS_ACTION. Nunca fecha a pendência. */
  private static async registrarTentativa(p: any): Promise<void> {
    const attempts = (p.attempts ?? 0) + 1;
    const esgotou = attempts >= STUCK_AFTER_ATTEMPTS;
    try {
      await (prisma as any).orderReturnPendency.update({
        where: { id: p.id },
        data: {
          attempts,
          nextRetryAt: OrderReturnPendencyService.nextRetryFrom(attempts),
          // Sai da fila automática, CONTINUA na tela. A peça está parada num
          // limbo que só o lojista resolve — e continuar consultando a API não
          // muda isso.
          ...(esgotou ? { status: "NEEDS_ACTION" } : {}),
        },
      });
    } catch (err) {
      console.error(
        `[OrderReturnPendencyReconciler] Falha ao registrar tentativa de #${p.externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  static start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error("[OrderReturnPendencyReconciler] runOnce failed:", err);
      });
    }, intervalMs);
    console.log(
      `[OrderReturnPendencyReconciler] started (interval=${intervalMs}ms)`,
    );
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
    this.runInProgress = false;
  }
}
