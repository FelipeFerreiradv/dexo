import { redirect } from "next/navigation";
import type { Session } from "next-auth";

import prisma from "@/app/lib/prisma";
import { hasPageAccess, type PageId } from "@/app/lib/page-access";

/**
 * Entrega C — Guarda server-side de acesso a uma página (colaboradores).
 *
 * Chamado nas páginas server LOGO APÓS o guard de sessão existente (que já
 * redireciona para /login), reaproveitando a mesma `session` (sem 2ª chamada a
 * getServerSession). Semântica:
 *  - Admin/superadmin (sem parentUserId) → acesso total, sem query extra.
 *  - Colaborador → LEITURA FRESCA de pagePermissions (efeito imediato quando o
 *    admin desliga a página; não depende do JWT, que só atualiza no relogin).
 *    Bloqueado → redireciona para '/' (Dashboard é sempre acessível → sem loop).
 */
export async function assertPageAccess(
  session: Session,
  pageId: PageId,
): Promise<void> {
  const user = session.user as {
    id: string;
    parentUserId?: string | null;
    role?: string | null;
  };

  // Admin/superadmin: nada a verificar.
  if (!user?.parentUserId) return;

  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: { parentUserId: true, role: true, pagePermissions: true },
  });

  const allowed = hasPageAccess(
    {
      parentUserId: fresh?.parentUserId ?? user.parentUserId,
      role: fresh?.role ?? user.role,
      pagePermissions:
        (fresh?.pagePermissions as Record<string, boolean> | null) ?? null,
    },
    pageId,
  );

  if (!allowed) {
    redirect("/");
  }
}
