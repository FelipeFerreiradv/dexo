import {
  Scrap,
  ScrapCreate,
  ScrapUpdate,
  ScrapStatus,
} from "../interfaces/scrap.interface";
import { ScrapRepositoryPrisma } from "../repositories/scrap.repository";

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

  async listScraps(options: {
    search?: string;
    status?: ScrapStatus;
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
