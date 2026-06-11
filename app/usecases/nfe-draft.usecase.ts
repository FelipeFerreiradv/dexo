import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import type {
  NfeDraftCreateInput,
  NfeDraftUpdateInput,
  NfeDraftResponse,
  CustomerLookup,
  ProductLookup,
  NfeDraftItem,
  NfeDestinatario,
} from "../interfaces/nfe.interface";

// ── Fase 8 — input para pré-popular draft a partir de venda balcão ──
// O caller (FinanceUseCase) é responsável por mapear Receivable + Customer
// para esta forma. NfeDraftUseCase apenas orquestra createDraft + updateDraft
// + addAuditLog, garantindo um draft FRESCO (sem reuso do mais-recente — o
// que `create()` faz e não cabe aqui).
export interface NfeDraftFromReceivableInput {
  customerId: string;
  receivableId: string;
  destinatario: NfeDestinatario;
  itens: NfeDraftItem[];
  pagamentos: Array<{ meio: string; valor: number }>;
}

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

    const draft = await this.nfeRepo.createDraft(userId, {
      ...input,
      ambiente: (config.ambiente as "HOMOLOGACAO" | "PRODUCAO") ?? "HOMOLOGACAO",
      // Série padrão fixada na configuração fiscal (o usuário pode trocar no
      // wizard). Default 1 quando a config ainda não tem série definida.
      serie: input.serie ?? config.serieNfe ?? 1,
    });

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

  // ── Fase 8 — Cupom fiscal de venda balcão (Opção A: NF-e modelo 55) ──
  //
  // Cria um draft FRESCO (não reusa o "mais recente" do usuário — que é o
  // que `create()` faz quando não há orderId) e o popula com destinatário,
  // itens e pagamento derivados da Conta a Receber. Itens entram com
  // defaults seguros (CFOP 5102 venda dentro-do-estado, origem 0 nacional,
  // unidade UN, NCM em branco) — o usuário completa o NCM no editor de
  // rascunho fiscal existente antes de emitir.
  //
  // Retorna o draft já populado; a UI então redireciona ao editor fiscal
  // existente para revisão e emissão via NfeEmissionUseCase (pipeline
  // intacto — esta fase NÃO toca emissão, apenas o setup do rascunho).
  async createPopulatedFromReceivable(
    userId: string,
    input: NfeDraftFromReceivableInput,
  ): Promise<NfeDraftResponse> {
    const config = await this.configRepo.findByUserId(userId);
    if (!config) {
      throw new Error(
        "Configuração fiscal não encontrada. Configure o emissor antes de emitir cupom fiscal.",
      );
    }

    const ambiente =
      (config.ambiente as "HOMOLOGACAO" | "PRODUCAO") ?? "HOMOLOGACAO";

    // 1. Cria draft fresco — bypassa o reuso de "mais recente" (esse vive em
    //    `this.create`; aqui chamamos o repo direto para sempre ter um draft
    //    novo, evitando colisão com drafts não relacionados de outras
    //    operações fiscais do mesmo usuário).
    const draft = await this.nfeRepo.createDraft(userId, {
      customerId: input.customerId,
      ambiente,
      serie: config.serieNfe ?? 1,
    });

    // 2. Popula tudo via updateDraft (replace strategy para itens, igual ao
    //    fluxo manual do wizard fiscal). numeroPedido usa o id da Conta a
    //    Receber como anotação livre para auditoria (NfeEmitida não tem FK
    //    para Receivable — link textual no campo `numeroPedido`).
    const filled = await this.nfeRepo.updateDraft(userId, draft.id, {
      tipoOperacao: "SAIDA",
      finalidade: "NORMAL",
      destinoOperacao: "INTERNA",
      naturezaOperacao: "VENDA DE MERCADORIA",
      indPresenca: "PRESENCIAL",
      customerId: input.customerId,
      destinatarioJson: input.destinatario,
      itens: input.itens,
      pagamentosJson: input.pagamentos,
      numeroPedido: `receivable:${input.receivableId}`,
    });

    await this.nfeRepo.addAuditLog(draft.id, userId, "CRIADA", {
      source: "venda-balcao",
      receivableId: input.receivableId,
    });

    return filled;
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
