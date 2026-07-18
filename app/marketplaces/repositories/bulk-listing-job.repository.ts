import { BulkJobStatus, Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";

export type BulkListingPlatform = "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";

export interface BulkListingRequestSpec {
  platform: BulkListingPlatform;
  accountId: string;
  categoryId?: string;
  mlSettings?: {
    listingType?: string;
    hasWarranty?: boolean;
    warrantyUnit?: string;
    warrantyDuration?: number;
    itemCondition?: string;
    shippingMode?: string;
    freeShipping?: boolean;
    localPickup?: boolean;
    manufacturingTime?: number;
  };
}

/**
 * Override por produto (modo "Revisão individual" do bulk). ADITIVO: viaja
 * DENTRO de `overrideTemplate.perProductOverrides`. Quando ausente, o dispatcher
 * se comporta byte-idêntico ao fluxo de regra global. Categoria/mlSettings são
 * aplicados no CREATE; attributes/listingPrice no override pós-create; o skip de
 * contas (`disabled*AccountIds`) poda os pares produto×conta.
 */
export interface PerProductMlOverride {
  categoryId?: string;
  listingType?: string;
  itemCondition?: string;
  hasWarranty?: boolean;
  warrantyUnit?: string;
  warrantyDuration?: number;
  shippingMode?: string;
  freeShipping?: boolean;
  localPickup?: boolean;
  manufacturingTime?: number;
  listingPrice?: number;
  catalogProductId?: string;
  attributes?: Record<string, { value_id?: string; value_name?: string }>;
}

export interface PerProductShopeeOverride {
  categoryId?: string;
}

export interface PerProductMagaluOverride {
  categoryId?: string;
}

export interface PerProductOverrideEntry {
  ml?: PerProductMlOverride;
  shopee?: PerProductShopeeOverride;
  magalu?: PerProductMagaluOverride;
  disabledMlAccountIds?: string[];
  disabledShopeeAccountIds?: string[];
  disabledMagaluAccountIds?: string[];
}

export interface BulkOverrideTemplate {
  priceRule?:
    | { type: "keep" }
    | { type: "fixed"; value: number }
    | { type: "markup_pct"; value: number }
    | { type: "delta_pct"; value: number };
  stockRule?: { type: "use_product" } | { type: "cap"; value: number };
  titleSuffix?: string;
  mlCategoryStrategy?: "auto" | "from_product";

  // Aumento percentual escalonado entre contas. Enriquecido e persistido
  // pelo endpoint POST /listings/bulk (o front envia apenas { enabled, percent }).
  // Os mapas congelam a ordem de seleção das contas para que o retry reproduza
  // preços idênticos. Cada plataforma tem escada 0-based PRÓPRIA e lê SOMENTE o
  // seu mapa (sem fallback cruzado). `indexByAccountId` é o mapa ML — nome
  // legado, mantido por compat com jobs já persistidos em JSON; os mapas
  // Shopee/Magalu são opcionais e ausentes em jobs antigos (⇒ comportamento
  // ML-only, idêntico ao anterior). O percentual é GLOBAL (único para as 3
  // plataformas). Ver cross-account-price.service e o kill-switch
  // CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED.
  crossAccountIncrease?: {
    enabled: boolean;
    percent: number;
    indexByAccountId?: Record<string, number>;
    shopeeIndexByAccountId?: Record<string, number>;
    magaluIndexByAccountId?: Record<string, number>;
  };

  // Config por produto (modo Revisão individual). Opcional/aditivo: ausente ⇒
  // comportamento atual. Persistido junto ao job (coluna `overrideTemplate`
  // JSON, sem migration) ⇒ o retry-failed relê e reproduz fielmente.
  perProductOverrides?: Record<string, PerProductOverrideEntry>;
}

export interface BulkListingItemResult {
  productId: string;
  platform: BulkListingPlatform;
  accountId: string;
  success: boolean;
  listingId?: string;
  externalListingId?: string;
  error?: string;
  finishedAt: string;
}

/**
 * Repositório para BulkListingJob — agregador de execução em lote de
 * criação de anúncios em múltiplos marketplaces / contas.
 *
 * Convenções:
 *  - `results` é JSONB acumulado durante o processamento (append-only por
 *    item). Concorrência de 4 workers atualiza linha a linha; usamos
 *    transação curta para ler/anexar/salvar de forma segura.
 *  - Status terminal: COMPLETED (todos sucesso), FAILED_PARTIAL (mistura),
 *    FAILED (todos falharam).
 */
export class BulkListingJobRepository {
  static async create(data: {
    userId: string;
    productIds: string[];
    requests: BulkListingRequestSpec[];
    overrideTemplate?: BulkOverrideTemplate | null;
    // Total efetivo de anúncios. Quando ausente, usa produtos×requests (igual ao
    // de hoje). O modo Revisão individual passa o total já descontando os skips
    // de conta por produto, para o progresso bater com o real.
    totalItems?: number;
  }) {
    const totalItems =
      data.totalItems ?? data.productIds.length * data.requests.length;
    return prisma.bulkListingJob.create({
      data: {
        userId: data.userId,
        productIds: data.productIds,
        requests: data.requests as unknown as Prisma.InputJsonValue,
        overrideTemplate: data.overrideTemplate
          ? (data.overrideTemplate as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        totalItems,
        status: BulkJobStatus.QUEUED,
      },
    });
  }

  static async findByIdAndUser(id: string, userId: string) {
    return prisma.bulkListingJob.findFirst({
      where: { id, userId },
    });
  }

  static async markRunning(id: string) {
    return prisma.bulkListingJob.update({
      where: { id },
      data: { status: BulkJobStatus.RUNNING },
    });
  }

  /**
   * Anexa um resultado e incrementa contadores em UMA operação atômica,
   * usando o operador `||` do JSONB do Postgres. Vantagens vs `findUnique +
   * update` em transação:
   *  - 1 round-trip (era 2: SELECT + UPDATE).
   *  - Atomicidade real em concorrência: row-lock implícito do UPDATE evita
   *    lost-update quando 4 workers escrevem no mesmo job em paralelo.
   *  - Sem leitura prévia ⇒ payload menor na comunicação com o banco.
   */
  static async appendResult(id: string, item: BulkListingItemResult) {
    const itemAsArray = JSON.stringify([item]);
    const successDelta = item.success ? 1 : 0;
    const failedDelta = item.success ? 0 : 1;

    return prisma.$executeRaw`
      UPDATE "BulkListingJob"
      SET
        "results" = COALESCE("results", '[]'::jsonb) || ${itemAsArray}::jsonb,
        "doneItems" = "doneItems" + 1,
        "successItems" = "successItems" + ${successDelta},
        "failedItems" = "failedItems" + ${failedDelta},
        "updatedAt" = NOW()
      WHERE "id" = ${id}
    `;
  }

  static async markFinal(
    id: string,
    summary: { success: number; failed: number; lastError?: string | null },
  ) {
    let status: BulkJobStatus;
    if (summary.failed === 0) status = BulkJobStatus.COMPLETED;
    else if (summary.success === 0) status = BulkJobStatus.FAILED;
    else status = BulkJobStatus.FAILED_PARTIAL;

    return prisma.bulkListingJob.update({
      where: { id },
      data: {
        status,
        lastError: summary.lastError ?? null,
      },
    });
  }
}
