/**
 * Repositório da tabela ShipmentLabel (1:1 com Order). Usa `(prisma as any)`
 * — mesmo padrão de nfe.repository — para não depender da regeneração de tipos
 * do Prisma e não somar ao baseline de erros do tsc enquanto a migration não é
 * aplicada em todos os ambientes.
 */
import prisma from "../lib/prisma";

export interface ShipmentLabelRecord {
  id: string;
  orderId: string;
  provider: string;
  shipmentId: string | null;
  trackingNumber: string | null;
  labelStatus: string;
  labelSize: string | null;
  labelPdfPath: string | null;
  labelError: string | null;
  invoiceSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShipmentLabelWrite {
  provider: string;
  shipmentId?: string | null;
  trackingNumber?: string | null;
  labelStatus?: string;
  labelSize?: string | null;
  labelPdfPath?: string | null;
  labelError?: string | null;
  invoiceSentAt?: Date | null;
}

class ShipmentLabelRepositoryPrisma {
  async findByOrderId(orderId: string): Promise<ShipmentLabelRecord | null> {
    const row = await (prisma as any).shipmentLabel.findUnique({
      where: { orderId },
    });
    return row ?? null;
  }

  /**
   * Cria ou atualiza a etiqueta do pedido. Idempotente por orderId (@unique).
   * Campos `undefined` não são alterados no update.
   */
  async upsert(
    orderId: string,
    data: ShipmentLabelWrite,
  ): Promise<ShipmentLabelRecord> {
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) update[key] = value;
    }
    return (prisma as any).shipmentLabel.upsert({
      where: { orderId },
      create: { orderId, ...data },
      update,
    });
  }
}

export const shipmentLabelRepository = new ShipmentLabelRepositoryPrisma();
export { ShipmentLabelRepositoryPrisma };
