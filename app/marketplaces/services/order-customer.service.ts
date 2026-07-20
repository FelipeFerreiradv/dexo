/**
 * OrderCustomerService — auto-cadastro de Customer a partir de venda de
 * marketplace (ML/Shopee/Magalu), com deduplicação.
 *
 * Chamado pelos importadores de pedido (OrderUseCase) SOMENTE para pedidos
 * novos, depois da baixa de estoque. Best-effort por contrato: NUNCA lança —
 * qualquer falha aqui não pode afetar a importação do pedido.
 *
 * Kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 restaura o caminho atual
 * byte-idêntico (nenhuma query/chamada de API extra).
 *
 * Dedupe (padrão canônico do projeto): documento quando houver (11=CPF,
 * 14=CNPJ); senão e-mail; senão nome. Hit → só vincula (nunca atualiza um
 * Customer existente). Miss → cria via CustomerUseCase (mesmo funil de
 * validação do CRM) com a origem registrada em `notes`.
 */

import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { MLApiService } from "./ml-api.service";
import { ShopeeApiService } from "./shopee-api.service";
import { MagaluApiService } from "./magalu-api.service";
import { CustomerRepository } from "@/app/repositories/customer.repository";
import { CustomerUseCase } from "@/app/usecases/customer.usecase";
import { orderRepository } from "@/app/repositories/order.repository";
import { SystemLogService } from "@/app/services/system-log.service";
import {
  mapDestinatarioToCustomer,
  mapMarketplaceBillingToDestinatario,
  type MarketplaceBillingSnapshot,
} from "@/app/usecases/nfe-customer-mapping";
import type {
  Customer,
  CustomerCreate,
} from "@/app/interfaces/customer.interface";

export type OrderCustomerPlatform = "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";

export interface EnsureCustomerForOrderInput {
  platform: OrderCustomerPlatform;
  marketplaceAccountId: string;
  /** Order.id local do pedido recém-criado. */
  orderId: string;
  /** Id do pedido no marketplace (usado no enriquecimento e na origem). */
  externalOrderId: string;
  /** Nome do comprador já capturado no import (fallback do snapshot). */
  fallbackName?: string | null;
  /** E-mail do comprador já capturado no import (fallback do snapshot). */
  fallbackEmail?: string | null;
}

export type EnsureCustomerOutcome =
  | {
      action: "disabled" | "skipped_no_identity" | "skipped_masked_name" | "failed";
    }
  | {
      action: "created" | "linked_existing";
      customerId: string;
      matchedBy: "cpf" | "cnpj" | "email" | "name" | null;
    };

const PLATFORM_LABELS: Record<OrderCustomerPlatform, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
};

/**
 * Conta usada para enriquecer o comprador. IMPORTANTE: este service NUNCA faz
 * refresh de token — os refresh tokens do ML/Shopee são single-use e um refresh
 * aqui sem persistir (ou concorrendo com o refresh do próprio loop de import)
 * queimaria o token do banco e derrubaria a conta (status ERROR → import para).
 * Token expirado ⇒ a chamada de API falha, é engolida e o cliente é criado só
 * com os dados do pedido (best-effort).
 */
type EnrichAccount = {
  id: string;
  userId: string;
  shopId: number | null;
  accessToken: string | null;
};

export class OrderCustomerService {
  // Instâncias próprias (CustomerRepository não tem singleton no projeto).
  // Testes espionam via CustomerRepository.prototype.
  private static customerRepo = new CustomerRepository();
  private static customerUseCase = new CustomerUseCase();

  /**
   * Garante um Customer para a venda: deduplica, cria se preciso e vincula
   * Order.customerId. NUNCA lança (best-effort por contrato).
   */
  static async ensureCustomerForOrder(
    input: EnsureCustomerForOrderInput,
  ): Promise<EnsureCustomerOutcome> {
    if (process.env.ORDER_AUTO_CUSTOMER_DISABLED === "1") {
      return { action: "disabled" };
    }
    try {
      return await this.run(input);
    } catch (error) {
      console.error(
        `[OrderCustomerService] Falha no auto-cadastro de cliente (pedido ${input.platform} #${input.externalOrderId}):`,
        error instanceof Error ? error.message : error,
      );
      return { action: "failed" };
    }
  }

  private static async run(
    input: EnsureCustomerForOrderInput,
  ): Promise<EnsureCustomerOutcome> {
    // Conta relida fresh do DB: tokens rotacionam durante o próprio import
    // (ML refresh token é single-use) — snapshot do caller ficaria stale.
    // EGRESS: variante lite — só dono/shopId/accessToken, não a row inteira.
    const account = await MarketplaceRepository.findByIdLite(
      input.marketplaceAccountId,
    );
    if (!account) return { action: "failed" };
    const ownerUserId = account.userId;

    // Enriquecimento best-effort (doc/e-mail/endereço do comprador).
    const snap = await this.buyerSnapshot(input.platform, account, input);

    // Identidade efetiva do comprador. Comprador estrangeiro (venda
    // cross-border ML): o documento NÃO é CPF/CNPJ (ex.: CUIT argentino tem 11
    // dígitos) — descarta doc e endereço, cria só com nome/e-mail.
    const country = (snap?.countryId ?? "BR").toUpperCase();
    const foreign = country !== "BR" && country !== "BRA" && country !== "1058";
    const doc = foreign ? null : this.sanitizeDoc(snap?.docNumber);
    const email = this.sanitizeEmail(snap?.email ?? input.fallbackEmail);
    const name =
      [snap?.name, snap?.lastName].filter(Boolean).join(" ").trim() ||
      (input.fallbackName ?? "").trim();
    const phone = snap?.phone ?? null;

    if (!doc && !email) {
      if (name.length < 2) return { action: "skipped_no_identity" };
      // Username mascarado (ex.: "j***o" do Shopee) não vira cliente no CRM.
      if (name.includes("*")) return { action: "skipped_masked_name" };
    }

    // Dedupe: documento quando houver; senão e-mail; senão nome (mais antigo).
    let matchedBy: "cpf" | "cnpj" | "email" | "name" | null = null;
    let existing: Customer | null = null;
    if (doc) {
      existing =
        doc.length === 11
          ? await this.customerRepo.findByCpf(doc, ownerUserId)
          : await this.customerRepo.findByCnpj(doc, ownerUserId);
      matchedBy = existing ? (doc.length === 11 ? "cpf" : "cnpj") : null;
    } else {
      if (email) {
        existing = await this.customerRepo.findByEmail(email, ownerUserId);
        matchedBy = existing ? "email" : null;
      }
      if (!existing && name.length >= 2 && !name.includes("*")) {
        existing = await this.customerRepo.findByName(name, ownerUserId);
        matchedBy = existing ? "name" : null;
      }
    }

    if (existing) {
      await this.linkOrder(input, existing.id);
      this.logOutcome(input, ownerUserId, existing.id, "linked_existing", matchedBy);
      return { action: "linked_existing", customerId: existing.id, matchedBy };
    }

    // Criação exige nome (coluna NOT NULL / assertValidNew do usecase).
    if (name.length < 2) return { action: "skipped_no_identity" };

    // Comprador estrangeiro: não mapeia endereço/doc para o shape BR do CRM.
    const data = this.buildCustomerCreate(input, ownerUserId, foreign ? null : snap, {
      doc,
      email,
      name,
      phone,
    });

    let created: Customer;
    try {
      created = await this.customerUseCase.create(data);
    } catch (error) {
      // Corrida benigna (outro processo criou o mesmo doc entre o lookup e o
      // create): re-busca uma vez e vincula.
      const msg = error instanceof Error ? error.message : "";
      const isDup =
        /já existe/i.test(msg) ||
        (error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "P2002");
      if (isDup && doc) {
        const raced =
          doc.length === 11
            ? await this.customerRepo.findByCpf(doc, ownerUserId)
            : await this.customerRepo.findByCnpj(doc, ownerUserId);
        if (raced) {
          const racedMatch = doc.length === 11 ? "cpf" : "cnpj";
          await this.linkOrder(input, raced.id);
          this.logOutcome(input, ownerUserId, raced.id, "linked_existing", racedMatch);
          return {
            action: "linked_existing",
            customerId: raced.id,
            matchedBy: racedMatch,
          };
        }
      }
      throw error;
    }

    await this.linkOrder(input, created.id);
    this.logOutcome(input, ownerUserId, created.id, "created", matchedBy);
    return { action: "created", customerId: created.id, matchedBy };
  }

  /** Monta o CustomerCreate reusando a cadeia pura da NF-e quando há snapshot. */
  private static buildCustomerCreate(
    input: EnsureCustomerForOrderInput,
    ownerUserId: string,
    snap: MarketplaceBillingSnapshot | null,
    identity: {
      doc: string | null;
      email: string | null;
      name: string;
      phone: string | null;
    },
  ): CustomerCreate {
    const dest = snap
      ? mapMarketplaceBillingToDestinatario(snap, identity.name, identity.email)
      : null;
    const data: CustomerCreate = dest
      ? mapDestinatarioToCustomer(dest, ownerUserId)
      : {
          userId: ownerUserId,
          name: identity.name,
          email: identity.email,
          phone: identity.phone,
        };
    // Normalização final do documento: o COMPRIMENTO decide tudo (coerente com
    // o dedupe acima). Os mapeadores da NF-e roteiam por docType, e a API pode
    // rotular errado (ex.: customer_type "cnpj" com 11 dígitos) — sem isso o
    // doc iria para o campo errado e o CustomerUseCase lançaria
    // "CPF/CNPJ inválido" para sempre para esse comprador.
    const isPj = identity.doc?.length === 14;
    data.personType = isPj ? "PJ" : "PF";
    data.cpf = identity.doc && !isPj ? identity.doc : null;
    data.cnpj = isPj ? identity.doc : null;
    data.razaoSocial = isPj ? (data.razaoSocial ?? identity.name) : null;
    if (!data.phone && identity.phone) data.phone = identity.phone;
    data.notes = `Criado automaticamente da venda ${PLATFORM_LABELS[input.platform]} · pedido #${input.externalOrderId}`;
    return data;
  }

  /** Vínculo Order.customerId — best-effort (falha não desfaz o cliente). */
  private static async linkOrder(
    input: EnsureCustomerForOrderInput,
    customerId: string,
  ): Promise<void> {
    try {
      await orderRepository.setCustomer(input.orderId, customerId);
    } catch (error) {
      console.error(
        `[OrderCustomerService] Falha ao vincular cliente ao pedido ${input.platform} #${input.externalOrderId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Log de auditoria sem PII (sem nome/doc/endereço — LGPD). */
  private static logOutcome(
    input: EnsureCustomerForOrderInput,
    ownerUserId: string,
    customerId: string,
    action: "created" | "linked_existing",
    matchedBy: "cpf" | "cnpj" | "email" | "name" | null,
  ): void {
    void SystemLogService.logInfo(
      "ORDER_AUTO_CUSTOMER",
      action === "created"
        ? `Cliente criado automaticamente da venda ${PLATFORM_LABELS[input.platform]} #${input.externalOrderId}`
        : `Cliente vinculado à venda ${PLATFORM_LABELS[input.platform]} #${input.externalOrderId}`,
      {
        userId: ownerUserId,
        resource: "Customer",
        resourceId: customerId,
        details: {
          orderId: input.orderId,
          externalOrderId: input.externalOrderId,
          platform: input.platform,
          action,
          matchedBy,
        },
      },
    ).catch(() => {});
  }

  // ── Enriquecimento por plataforma (espelho dos snapshots da NF-e draft) ──

  private static async buyerSnapshot(
    platform: OrderCustomerPlatform,
    account: EnrichAccount,
    input: EnsureCustomerForOrderInput,
  ): Promise<MarketplaceBillingSnapshot | null> {
    try {
      switch (platform) {
        case "MERCADO_LIVRE":
          return await this.mlSnapshot(account, input.externalOrderId);
        case "SHOPEE":
          return await this.shopeeSnapshot(account, input.externalOrderId);
        case "MAGALU":
          return await this.magaluSnapshot(account, input.externalOrderId);
      }
    } catch {
      return null;
    }
  }

  private static async mlSnapshot(
    acc: EnrichAccount,
    orderId: string,
  ): Promise<MarketplaceBillingSnapshot | null> {
    const token = acc.accessToken;
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

  private static async shopeeSnapshot(
    acc: EnrichAccount,
    orderSn: string,
  ): Promise<MarketplaceBillingSnapshot | null> {
    if (!acc.shopId) return null;
    const token = acc.accessToken;
    if (!token) return null;
    const od: any = await ShopeeApiService.getOrderFiscalInfo(
      token,
      acc.shopId,
      orderSn,
    );
    if (!od) return null;
    const ra = od.recipient_address ?? {};
    // Shopee não expõe o CPF do comprador; nome real + endereço + telefone.
    return {
      name: ra.name ?? null,
      docNumber: null,
      phone: ra.phone ?? null,
      cep: ra.zipcode ?? null,
      street: ra.full_address ?? ra.town ?? null,
      neighborhood: ra.district ?? null,
      city: ra.city ?? null,
      uf: ra.state ?? null,
      countryId: "BR",
    };
  }

  private static async magaluSnapshot(
    acc: EnrichAccount,
    orderId: string,
  ): Promise<MarketplaceBillingSnapshot | null> {
    const token = acc.accessToken;
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
  private static pickMagaluAddress(order: any): any | null {
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

  // ── Saneamento ──

  /** Só documento com 11 (CPF) ou 14 (CNPJ) dígitos vale como identidade. */
  private static sanitizeDoc(raw?: string | null): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    return digits.length === 11 || digits.length === 14 ? digits : null;
  }

  private static sanitizeEmail(raw?: string | null): string | null {
    const email = (raw ?? "").trim();
    return email.includes("@") ? email : null;
  }
}
