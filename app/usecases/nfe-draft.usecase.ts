import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { CustomerRepository } from "../repositories/customer.repository";
import { orderRepository } from "../repositories/order.repository";
import { mapCustomerToDestinatario } from "./nfe-customer-mapping";
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
  private customerRepo: CustomerRepository;

  constructor() {
    this.nfeRepo = new NfeRepository();
    this.configRepo = new CompanyFiscalRepository();
    this.customerRepo = new CustomerRepository();
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

    const ambiente =
      (config.ambiente as "HOMOLOGACAO" | "PRODUCAO") ?? "HOMOLOGACAO";
    // Série padrão fixada na configuração fiscal (o usuário pode trocar no
    // wizard). Default 1 quando a config ainda não tem série definida.
    const serie = input.serie ?? config.serieNfe ?? 1;

    // Com orderId: rascunho FRESCO já populado com os itens (produto +
    // quantidade + valor) e os dados do cliente do pedido — autopreenchimento
    // rico. NÃO toca o wizard/emissão: só enriquece os valores iniciais.
    if (input.orderId) {
      return this.createPopulatedFromOrder(
        userId,
        input.orderId,
        ambiente,
        serie,
        input.customerId ?? null,
      );
    }

    // Sem orderId: reusa o rascunho mais recente (comportamento atual).
    const existing = await this.nfeRepo.findExistingDraft(userId);
    if (existing) return existing;

    const draft = await this.nfeRepo.createDraft(userId, {
      ...input,
      ambiente,
      serie,
    });

    await this.nfeRepo.addAuditLog(draft.id, userId, "CRIADA", {
      orderId: null,
    });

    return draft;
  }

  // Pré-popula um rascunho a partir de um pedido de marketplace. Mesmo padrão
  // de `createPopulatedFromReceivable` (venda balcão): cria draft fresco +
  // updateDraft. Preenche:
  //  - destinatário: tenta casar o comprador a um Customer do mesmo dono
  //    (customerId explícito → e-mail do pedido → nome) e, se achar, preenche
  //    tudo (doc, IE, indicadorIE, telefone, endereço). Sem match, mantém o
  //    comportamento anterior (só nome + e-mail) — zero regressão;
  //  - itens: código (SKU), descrição (nome), quantidade, valor unit./total;
  //  - pagamento: valor = soma dos itens, meio "OUTROS" (pedido de marketplace
  //    não traz forma de pagamento fiscal) — o usuário ajusta.
  // NCM e CFOP entram VAZIOS de propósito: Product não tem NCM, e o CFOP
  // depende da UF do destinatário; São obrigatórios na emissão, então o usuário
  // completa no editor — o wizard e a emissão seguem 100% intactos.
  private async createPopulatedFromOrder(
    userId: string,
    orderId: string,
    ambiente: "HOMOLOGACAO" | "PRODUCAO",
    serie: number,
    customerId?: string | null,
  ): Promise<NfeDraftResponse> {
    const order = await orderRepository.findForFiscalDraft(orderId, userId);
    if (!order) {
      throw new Error("Pedido não encontrado");
    }

    // Casa o comprador a um Customer do dono para autopreencher o destinatário.
    let matched = customerId
      ? await this.customerRepo.findById(customerId, userId)
      : null;
    if (!matched && order.customerEmail) {
      matched = await this.customerRepo.findByEmail(order.customerEmail, userId);
    }
    if (!matched && order.customerName) {
      matched = await this.customerRepo.findByName(order.customerName, userId);
    }

    const mapped = matched ? mapCustomerToDestinatario(matched) : null;
    const destinatario: NfeDestinatario = mapped
      ? {
          ...mapped,
          // Preserva e-mail/nome do pedido quando o cadastro não tiver (não
          // sobrescreve a razão social já resolvida para PJ).
          nome: mapped.nome || order.customerName || "",
          email: mapped.email ?? order.customerEmail ?? null,
        }
      : {
          tipoPessoa: "PF",
          cpfCnpj: "",
          nome: order.customerName ?? "",
          inscricaoEstadual: null,
          indicadorIE: "9",
          email: order.customerEmail ?? null,
          telefone: null,
          cep: null,
          logradouro: null,
          numero: null,
          complemento: null,
          bairro: null,
          municipio: null,
          codMunicipio: null,
          uf: null,
          codPais: "1058",
          pais: "BRASIL",
        };

    const itens: NfeDraftItem[] = order.items.map((it, idx) => {
      const valorUnitario = it.unitPrice;
      return {
        numero: idx + 1,
        productId: it.productId ?? null,
        codigo: it.product?.sku ?? it.productId ?? "",
        descricao: it.product?.name ?? "",
        ncm: "",
        cfop: "",
        cest: null,
        origem: 0 as const,
        unidade: "UN",
        quantidade: it.quantity,
        valorUnitario,
        valorTotal: Number((it.quantity * valorUnitario).toFixed(2)),
        desconto: null,
        observacoes: null,
      };
    });

    // Pagamento = total dos itens (= total da nota, sem frete). Só entra quando
    // há itens; meio "OUTROS" (99) é o neutro p/ marketplace.
    const somaItens = Number(
      itens.reduce((acc, it) => acc + it.valorTotal, 0).toFixed(2),
    );
    const pagamentos =
      somaItens > 0 ? [{ meio: "OUTROS", valor: somaItens }] : [];

    const draft = await this.nfeRepo.createDraft(userId, {
      orderId,
      ambiente,
      serie,
    });

    const filled = await this.nfeRepo.updateDraft(userId, draft.id, {
      destinatarioJson: destinatario,
      itens,
      ...(pagamentos.length > 0 ? { pagamentosJson: pagamentos } : {}),
      numeroPedido: order.externalOrderId,
    });

    await this.nfeRepo.addAuditLog(draft.id, userId, "CRIADA", { orderId });

    return filled;
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
