import { BulkJobStatus, Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";

export type BulkListingPlatform = "MERCADO_LIVRE" | "SHOPEE";

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

export interface BulkOverrideTemplate {
  priceRule?:
    | { type: "keep" }
    | { type: "fixed"; value: number }
    | { type: "markup_pct"; value: number }
    | { type: "delta_pct"; value: number };
  stockRule?: { type: "use_product" } | { type: "cap"; value: number };
  titleSuffix?: string;
  mlCategoryStrategy?: "auto" | "from_product";
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
  }) {
    const totalItems = data.productIds.length * data.requests.length;
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
