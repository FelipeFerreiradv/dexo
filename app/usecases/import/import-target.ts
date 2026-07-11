/**
 * Validação do administrador-alvo da importação. Todos os dados criados vão
 * para o `userId` dele — o alvo tem de ser um ADMIN raiz (nunca colaborador
 * nem superadmin), para impedir importação em tenant errado por engano.
 */

import prisma from "../../lib/prisma";
import { ImportValidationError } from "./import.types";

export interface ImportTarget {
  id: string;
  email: string;
  name: string | null;
}

export async function assertTargetAdmin(
  targetUserId: string,
): Promise<ImportTarget> {
  if (!targetUserId) {
    throw new ImportValidationError("Informe o administrador-alvo (targetUserId).");
  }
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      parentUserId: true,
    },
  });
  if (!user) {
    throw new ImportValidationError("Administrador-alvo não encontrado.");
  }
  if (user.role !== "ADMIN" || user.parentUserId) {
    throw new ImportValidationError(
      "O alvo da importação deve ser um ADMINISTRADOR (não colaborador nem superadmin).",
    );
  }
  return { id: user.id, email: user.email, name: user.name };
}
