import {
  Scrap,
  ScrapCreate,
  ScrapUpdate,
  ScrapStatus,
  LogisticsStatus,
  ScrapPipeline,
  ScrapDetail,
  BalcaoPart,
} from "../interfaces/scrap.interface";
import { ScrapRepositoryPrisma } from "../repositories/scrap.repository";
import { ProductRepositoryPrisma } from "../repositories/product.repository";
import { SystemLogService } from "../services/system-log.service";

export class ScrapUseCase {
  private scrapRepository: ScrapRepositoryPrisma;
  private productRepository: ProductRepositoryPrisma;

  constructor() {
    this.scrapRepository = new ScrapRepositoryPrisma();
    this.productRepository = new ProductRepositoryPrisma();
  }

  async create(data: ScrapCreate): Promise<Scrap> {
    if (!data.userId) {
      throw new Error("Usuário não encontrado");
    }
    if (!data.brand || typeof data.brand !== "string") {
      throw new Error("Marca é obrigatória");
    }
    if (!data.model || typeof data.model !== "string") {
      throw new Error("Modelo é obrigatório");
    }

    // Validar chassi (17 caracteres alfanuméricos quando preenchido)
    if (data.chassis) {
      const cleaned = data.chassis.replace(/[^a-zA-Z0-9]/g, "");
      if (cleaned.length !== 17) {
        throw new Error(
          "Chassi deve conter exatamente 17 caracteres alfanuméricos",
        );
      }
    }

    // Validar chave de acesso NF-e (44 dígitos quando preenchida)
    if (data.accessKey) {
      const digits = data.accessKey.replace(/\D/g, "");
      if (digits.length !== 44) {
        throw new Error("Chave de acesso deve conter exatamente 44 dígitos");
      }
    }

    return this.scrapRepository.create(data);
  }

  async findById(id: string, userId?: string): Promise<Scrap | null> {
    return this.scrapRepository.findById(id, userId);
  }

  // Detalhe enriquecido do lote. Sem `include` retorna apenas a sucata
  // (idêntico ao findById). Investimento = cost + extraCosts; ROI calculado
  // aqui (usecase) a partir dos somatórios do repository.
  async getScrapDetail(
    id: string,
    userId: string,
    include?: {
      financials?: boolean;
      products?: boolean;
      history?: boolean;
      manualSales?: boolean;
    },
  ): Promise<ScrapDetail | null> {
    const scrap = await this.scrapRepository.findById(id, userId);
    if (!scrap) return null;

    const detail: ScrapDetail = { ...scrap };

    if (include?.financials) {
      const { marketplace, counter, potential } =
        await this.scrapRepository.getScrapMoney(id, userId);
      const investment = (scrap.cost ?? 0) + (scrap.extraCosts ?? 0);
      const realizedTotal = marketplace + counter;
      const roi =
        investment > 0
          ? ((realizedTotal - investment) / investment) * 100
          : null;
      detail.financials = {
        investment,
        realizedRevenue: { marketplace, counter, total: realizedTotal },
        potentialRevenue: potential,
        roi,
      };
    }

    if (include?.products) {
      detail.products = await this.scrapRepository.getScrapParts(id, userId);
    }

    if (include?.history) {
      detail.history = await this.scrapRepository.getStatusEvents(id, userId);
    }

    if (include?.manualSales) {
      detail.manualSales = await this.scrapRepository.getScrapManualSales(
        id,
        userId,
      );
    }

    return detail;
  }

  async listScraps(options: {
    search?: string;
    status?: ScrapStatus;
    logisticsStatus?: LogisticsStatus;
    page?: number;
    limit?: number;
    userId: string;
  }): Promise<{ scraps: Scrap[]; total: number; totalPages: number }> {
    const { userId, ...rest } = options;
    const data = await this.scrapRepository.findAll(rest, userId);
    return {
      ...data,
      totalPages: Math.ceil(data.total / (options?.limit || 10)),
    };
  }

  async getPipeline(userId: string): Promise<ScrapPipeline> {
    if (!userId) {
      throw new Error("Usuário não encontrado");
    }
    return this.scrapRepository.pipeline(userId);
  }

  // Visão de Balcão: reaproveita o ranking da busca de produtos (3 tiers
  // tokenizados) e enriquece cada peça com o lote de origem + estágio
  // logístico, num batch só (sem N+1). Escopado por userId.
  async balcaoSearch(
    q: string,
    userId: string,
    limit = 12,
  ): Promise<{ results: BalcaoPart[] }> {
    const term = (q ?? "").trim();
    if (!userId || term.length < 2) return { results: [] };

    const { products } = await this.productRepository.findAll(
      { search: term, limit },
      userId,
    );

    const scrapIds = Array.from(
      new Set(
        products
          .map((p) => p.scrapId)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
      ),
    );

    const scraps = await this.scrapRepository.findStagesByIds(scrapIds, userId);
    const byId = new Map(scraps.map((s) => [s.id, s]));

    const results: BalcaoPart[] = products.map((p) => {
      const s = p.scrapId ? byId.get(p.scrapId) : undefined;
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        partNumber: p.partNumber ?? undefined,
        price: Number(p.price ?? 0),
        stock: p.stock ?? 0,
        source: s
          ? {
              scrapId: s.id,
              brand: s.brand,
              model: s.model,
              year: s.year ?? undefined,
              plate: s.plate ?? undefined,
              logisticsStatus: s.logisticsStatus,
            }
          : null,
      };
    });

    return { results };
  }

  private static readonly VALID_LOGISTICS: LogisticsStatus[] = [
    "IN_TRANSIT",
    "IN_YARD",
    "ON_LIFT",
    "DISMANTLED",
  ];

  async transitionLogistics(
    id: string,
    logisticsStatus: LogisticsStatus,
    userId?: string,
  ): Promise<Scrap> {
    if (!ScrapUseCase.VALID_LOGISTICS.includes(logisticsStatus)) {
      throw new Error("Status logístico inválido");
    }

    const existing = await this.scrapRepository.findById(id, userId);
    if (!existing) {
      throw new Error("Sucata não encontrada");
    }

    const updated = await this.scrapRepository.updateLogisticsStatus(
      id,
      logisticsStatus,
      userId,
    );

    // Histórico estruturado da transição (diferencial F). Best-effort: uma
    // falha ao gravar o evento não pode derrubar a transição em si.
    if (userId) {
      try {
        await this.scrapRepository.recordStatusEvent(
          id,
          userId,
          existing.logisticsStatus,
          logisticsStatus,
        );
      } catch (err) {
        console.error("[ScrapUseCase] Falha ao gravar ScrapStatusEvent:", err);
      }
    }

    // Carimbo de tempo da transição (auditoria + base para o histórico da
    // Fase F). Defensivo: SystemLogService.log já engole erros internamente,
    // então uma falha de log nunca derruba a transição.
    await SystemLogService.logInfo(
      "UPDATE_SCRAP",
      `Estágio logístico: ${existing.logisticsStatus} -> ${logisticsStatus}`,
      {
        userId,
        resource: "Scrap",
        resourceId: id,
        details: {
          field: "logisticsStatus",
          from: existing.logisticsStatus,
          to: logisticsStatus,
        },
      },
    );

    return updated;
  }

  async update(id: string, data: ScrapUpdate, userId?: string): Promise<Scrap> {
    const existing = await this.scrapRepository.findById(id, userId);
    if (!existing) {
      throw new Error("Sucata não encontrada");
    }

    // Validar chassi ao atualizar
    if (data.chassis) {
      const cleaned = data.chassis.replace(/[^a-zA-Z0-9]/g, "");
      if (cleaned.length !== 17) {
        throw new Error(
          "Chassi deve conter exatamente 17 caracteres alfanuméricos",
        );
      }
    }

    // Validar chave de acesso ao atualizar
    if (data.accessKey) {
      const digits = data.accessKey.replace(/\D/g, "");
      if (digits.length !== 44) {
        throw new Error("Chave de acesso deve conter exatamente 44 dígitos");
      }
    }

    return this.scrapRepository.update(id, data, userId);
  }

  async delete(id: string, userId?: string): Promise<void> {
    const existing = await this.scrapRepository.findById(id, userId);
    if (!existing) {
      throw new Error("Sucata não encontrada");
    }

    return this.scrapRepository.delete(id, userId);
  }
}
