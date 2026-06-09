import {
  Scrap,
  ScrapCreate,
  ScrapUpdate,
  ScrapStatus,
  LogisticsStatus,
  ScrapPipeline,
  ScrapDetail,
} from "../interfaces/scrap.interface";
import { ScrapRepositoryPrisma } from "../repositories/scrap.repository";
import { SystemLogService } from "../services/system-log.service";

export class ScrapUseCase {
  private scrapRepository: ScrapRepositoryPrisma;

  constructor() {
    this.scrapRepository = new ScrapRepositoryPrisma();
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
    include?: { financials?: boolean; products?: boolean },
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
      detail.products = await this.scrapRepository.getScrapParts(id);
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
