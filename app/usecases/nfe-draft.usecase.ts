import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import type {
  NfeDraftCreateInput,
  NfeDraftUpdateInput,
  NfeDraftResponse,
  CustomerLookup,
  ProductLookup,
} from "../interfaces/nfe.interface";

export class NfeDraftUseCase {
  private nfeRepo: NfeRepository;
  private configRepo: CompanyFiscalRepository;

  constructor() {
    this.nfeRepo = new NfeRepository();
    this.configRepo = new CompanyFiscalRepository();
  }

  async create(
    userId: string,
    input: NfeDraftCreateInput,
  ): Promise<NfeDraftResponse> {
    // Verify fiscal config exists
    const config = await this.configRepo.findByUserId(userId);
    if (!config) {
      throw new Error(
        "Configuração fiscal não encontrada. Configure o emissor antes de criar uma NF-e.",
      );
    }

    // If no orderId specified, reuse the most recent existing draft
    if (!input.orderId) {
      const existing = await this.nfeRepo.findExistingDraft(userId);
      if (existing) return existing;
    }

    const draft = await this.nfeRepo.createDraft(userId, input);

    await this.nfeRepo.addAuditLog(draft.id, userId, "CRIADA", {
      orderId: input.orderId ?? null,
    });

    return draft;
  }

  async getById(
    userId: string,
    id: string,
  ): Promise<NfeDraftResponse> {
    const draft = await this.nfeRepo.findDraftById(userId, id);
    if (!draft) {
      throw new Error("Rascunho não encontrado");
    }
    return draft;
  }

  async update(
    userId: string,
    id: string,
    input: NfeDraftUpdateInput,
  ): Promise<NfeDraftResponse> {
    // Ensure draft exists and belongs to user
    const existing = await this.nfeRepo.findDraftById(userId, id);
    if (!existing) {
      throw new Error("Rascunho não encontrado");
    }

    const updated = await this.nfeRepo.updateDraft(userId, id, input);

    await this.nfeRepo.addAuditLog(id, userId, "EDITADA_DRAFT", {
      fields: Object.keys(input),
    });

    return updated;
  }

  async delete(userId: string, id: string): Promise<void> {
    const existing = await this.nfeRepo.findDraftById(userId, id);
    if (!existing) {
      throw new Error("Rascunho não encontrado");
    }

    await this.nfeRepo.deleteDraft(userId, id);
  }

  // ── Lookups ──

  async lookupCustomers(
    userId: string,
    query: string,
  ): Promise<CustomerLookup[]> {
    if (!query || query.trim().length < 2) return [];
    return this.nfeRepo.lookupCustomers(userId, query.trim());
  }

  async lookupProducts(
    userId: string,
    query: string,
  ): Promise<ProductLookup[]> {
    if (!query || query.trim().length < 2) return [];
    return this.nfeRepo.lookupProducts(userId, query.trim());
  }
}
