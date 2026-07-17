import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { CustomerRepository } from "../repositories/customer.repository";
import { orderRepository } from "../repositories/order.repository";
import {
  mapCustomerToDestinatario,
  mapMarketplaceBillingToDestinatario,
  type MarketplaceBillingSnapshot,
} from "./nfe-customer-mapping";
import type { Customer } from "../interfaces/customer.interface";
import { MLApiService } from "../marketplaces/services/ml-api.service";
import { MLOAuthService } from "../marketplaces/services/ml-oauth.service";
import { ShopeeApiService } from "../marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../marketplaces/services/shopee-oauth.service";
import { MagaluApiService } from "../marketplaces/services/magalu-api.service";
import { MagaluOAuthService } from "../marketplaces/services/magalu-oauth.service";

/** Conta de origem do pedido usada p/ buscar dados fiscais do comprador. */
type BillingAccount = {
  id: string;
  platform: string;
  shopId: number | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
};
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
  /**
   * Modelo do documento (Fase 2 — NFC-e do PDV). Ausente ⇒ "55"
   * (fluxo do cupom fiscal atual byte-idêntico). Com "65": usa a série
   * própria da NFC-e (config.serieNfce) e autopreenche NCM vazio com o
   * NCM padrão da configuração fiscal.
   */
  modelo?: "55" | "65";
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
    // Best-effort: uma falha no lookup NUNCA bloqueia o rascunho — cai no
    // destinatário mínimo (nome/e-mail do pedido), preservando o comportamento
    // anterior.
    let matched: Customer | null = null;
    try {
      if (customerId) {
        matched = await this.customerRepo.findById(customerId, userId);
      }
      if (!matched && order.customerEmail) {
        matched = await this.customerRepo.findByEmail(
          order.customerEmail,
          userId,
        );
      }
      if (!matched && order.customerName) {
        matched = await this.customerRepo.findByName(order.customerName, userId);
      }
    } catch (err) {
      console.error(
        "[nfe-draft] lookup de cliente falhou (segue com nome/e-mail):",
        err instanceof Error ? err.message : err,
      );
      matched = null;
    }

    const mapped = matched ? mapCustomerToDestinatario(matched) : null;
    // Sem Customer casado, tenta os dados fiscais REAIS do comprador no
    // marketplace (ML billing_info) — nome, CPF/CNPJ e endereço. Best-effort.
    const fromBilling = mapped ? null : await this.tryMarketplaceBilling(order);
    const destinatario: NfeDestinatario = mapped
      ? {
          ...mapped,
          // Preserva e-mail/nome do pedido quando o cadastro não tiver (não
          // sobrescreve a razão social já resolvida para PJ).
          nome: mapped.nome || order.customerName || "",
          email: mapped.email ?? order.customerEmail ?? null,
        }
      : (fromBilling ?? {
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
        });

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

  // Best-effort: dados fiscais do comprador (nome/CPF/endereço) na API do
  // marketplace quando o pedido não casa um Customer. Despacha por plataforma;
  // falha/ausência → null (cai no fallback nome). NÃO loga os dados (LGPD).
  private async tryMarketplaceBilling(order: {
    externalOrderId: string;
    customerName: string | null;
    customerEmail: string | null;
    marketplaceAccount: BillingAccount | null;
  }): Promise<NfeDestinatario | null> {
    const acc = order.marketplaceAccount;
    if (!acc) return null;
    try {
      let snap: MarketplaceBillingSnapshot | null = null;
      if (acc.platform === "MERCADO_LIVRE") {
        snap = await this.mlBillingSnapshot(acc, order.externalOrderId);
      } else if (acc.platform === "SHOPEE") {
        snap = await this.shopeeBillingSnapshot(acc, order.externalOrderId);
      } else if (acc.platform === "MAGALU") {
        snap = await this.magaluBillingSnapshot(acc, order.externalOrderId);
      }
      if (!snap) return null;
      return mapMarketplaceBillingToDestinatario(
        snap,
        order.customerName,
        order.customerEmail,
      );
    } catch {
      return null;
    }
  }

  private async mlBillingSnapshot(
    acc: BillingAccount,
    orderId: string,
  ): Promise<MarketplaceBillingSnapshot | null> {
    let token = acc.accessToken;
    if (this.tokenSoon(acc) && acc.refreshToken) {
      try {
        token = (
          await MLOAuthService.refreshAccessTokenForAccount(
            acc.id,
            acc.refreshToken,
          )
        ).accessToken;
      } catch {
        /* mantém o token atual */
      }
    }
    if (!token) return null;
    const billing = await MLApiService.getOrderBillingInfo(token, orderId);
    const bi = billing?.buyer?.billing_info;
    if (!bi) return null;
    return {
      name: bi.name,
      lastName: bi.last_name,
      docType: bi.identification?.type,
      docNumber: bi.identification?.number,
      cep: bi.address?.zip_code,
      street: bi.address?.street_name,
      number: bi.address?.street_number,
      neighborhood: bi.address?.neighborhood,
      city: bi.address?.city_name,
      uf: bi.address?.state?.code,
      countryId: bi.address?.country_id,
      countryName: bi.address?.state?.name,
    };
  }

  private async shopeeBillingSnapshot(
    acc: BillingAccount,
    orderSn: string,
  ): Promise<MarketplaceBillingSnapshot | null> {
    if (!acc.shopId) return null;
    let token = acc.accessToken;
    if (this.tokenSoon(acc) && acc.refreshToken) {
      try {
        token = (
          await ShopeeOAuthService.refreshAccessToken(acc.refreshToken, acc.shopId)
        ).access_token;
      } catch {
        /* mantém o token atual */
      }
    }
    if (!token) return null;
    const od: any = await ShopeeApiService.getOrderFiscalInfo(
      token,
      acc.shopId,
      orderSn,
    );
    if (!od) return null;
    const ra = od.recipient_address ?? {};
    // A Shopee NÃO expõe o CPF do comprador: `invoice_data.number` é o número da
    // NF-e (não o documento). Verificado via probe na VPS. Preenche nome +
    // endereço + telefone; o CPF/CNPJ fica em branco p/ o usuário informar.
    return {
      name: ra.name ?? null,
      docNumber: null,
      phone: ra.phone ?? null,
      cep: ra.zipcode ?? null,
      // Shopee dá o endereço num único `full_address` (sem número separado).
      street: ra.full_address ?? ra.town ?? null,
      neighborhood: ra.district ?? null,
      city: ra.city ?? null,
      uf: ra.state ?? null,
      countryId: "BR",
    };
  }

  private async magaluBillingSnapshot(
    acc: BillingAccount,
    orderId: string,
  ): Promise<MarketplaceBillingSnapshot | null> {
    let token = acc.accessToken;
    if (this.tokenSoon(acc) && acc.refreshToken) {
      try {
        token = (
          await MagaluOAuthService.refreshAccessTokenForAccount(
            acc.id,
            acc.refreshToken,
          )
        ).accessToken;
      } catch {
        /* mantém o token atual */
      }
    }
    if (!token) return null;
    const order: any = await MagaluApiService.getOrder(token, orderId).catch(
      () => null,
    );
    if (!order) return null;
    const c = order.customer ?? {};
    const p = Array.isArray(c.phones) ? c.phones[0] : null;
    const phone = p ? `${p.area_code ?? ""}${p.number ?? ""}` || null : null;
    const addr = this.pickMagaluAddress(order);
    return {
      name: c.name ?? null,
      docType: c.customer_type ?? null, // "cpf" | "cnpj"
      docNumber: c.document_number ?? null,
      email: c.email ?? null,
      phone,
      cep: addr?.zipcode ?? null,
      street: addr?.street ?? null,
      number: addr?.number ?? null,
      neighborhood: addr?.district ?? null,
      city: addr?.city ?? null,
      uf: addr?.state ?? null,
      countryId: "BR",
    };
  }

  /** Endereço postal do pedido Magalu (1º com CEP/rua entre drop/pickup/recipient). */
  private pickMagaluAddress(order: any): any | null {
    const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
    for (const d of deliveries) {
      const sh = d?.shipping ?? {};
      for (const cand of [
        sh.recipient?.address,
        sh.drop_details?.address,
        sh.pickup_details?.address,
      ]) {
        if (cand && (cand.zipcode || cand.street)) return cand;
      }
    }
    return null;
  }

  private tokenSoon(acc: BillingAccount): boolean {
    return (
      !acc.accessToken ||
      (acc.expiresAt ? acc.expiresAt.getTime() - Date.now() < 60_000 : false)
    );
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

    // NFC-e (Fase 2): modelo opcional; ausente ⇒ "55" (caminho atual intacto).
    const modelo: "55" | "65" = input.modelo === "65" ? "65" : "55";

    // NCM padrão da config autopreenche APENAS itens sem NCM no fluxo 65
    // (1 clique do PDV). NCM segue obrigatório na emissão.
    const itens =
      modelo === "65" && config.ncmPadrao
        ? input.itens.map((it) => ({
            ...it,
            ncm: it.ncm || (config.ncmPadrao as string),
          }))
        : input.itens;

    // 1. Cria draft fresco — bypassa o reuso de "mais recente" (esse vive em
    //    `this.create`; aqui chamamos o repo direto para sempre ter um draft
    //    novo, evitando colisão com drafts não relacionados de outras
    //    operações fiscais do mesmo usuário).
    const draft = await this.nfeRepo.createDraft(userId, {
      customerId: input.customerId,
      ambiente,
      serie:
        modelo === "65" ? (config.serieNfce ?? 1) : (config.serieNfe ?? 1),
      modelo,
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
      itens,
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
