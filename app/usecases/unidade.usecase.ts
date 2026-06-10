import {
  Unidade,
  UnidadeCreate,
  UnidadeListResult,
  UnidadeUpdate,
} from "../interfaces/unidade.interface";
import { UnidadeRepository } from "../repositories/unidade.repository";

export class UnidadeUseCase {
  private repo: UnidadeRepository;

  constructor() {
    this.repo = new UnidadeRepository();
  }

  async create(data: UnidadeCreate): Promise<Unidade> {
    if (!data.userId) throw new Error("Usuário não encontrado");
    if (!data.name || data.name.trim().length < 2) {
      throw new Error("Nome é obrigatório");
    }

    const code = data.code?.trim() || null;
    if (code) {
      const existing = await this.repo.findByCode(code, data.userId);
      if (existing) {
        throw new Error("Já existe uma unidade com esse identificador");
      }
    }

    return this.repo.create({
      userId: data.userId,
      name: data.name.trim(),
      code,
      notes: data.notes?.trim() || null,
      active: data.active ?? true,
    });
  }

  async update(
    id: string,
    userId: string,
    data: UnidadeUpdate,
  ): Promise<Unidade> {
    if (
      data.name !== undefined &&
      (!data.name || data.name.trim().length < 2)
    ) {
      throw new Error("Nome é obrigatório");
    }

    if (data.code) {
      const code = data.code.trim();
      const existing = await this.repo.findByCode(code, userId);
      if (existing && existing.id !== id) {
        throw new Error("Já existe uma unidade com esse identificador");
      }
    }

    const patch: UnidadeUpdate = { ...data };
    if (patch.name !== undefined) patch.name = patch.name!.trim();
    if (patch.code !== undefined)
      patch.code = patch.code ? patch.code.trim() : null;
    if (patch.notes !== undefined)
      patch.notes = patch.notes ? patch.notes.trim() : null;

    return this.repo.update(id, userId, patch);
  }

  async findById(id: string, userId: string): Promise<Unidade> {
    const u = await this.repo.findById(id, userId);
    if (!u) throw new Error("Unidade não encontrada");
    return u;
  }

  async list(
    userId: string,
    includeInactive: boolean,
  ): Promise<UnidadeListResult> {
    return this.repo.findAll(userId, includeInactive);
  }
}
