import { redirect } from "next/navigation";
import type { Session } from "next-auth";

import prisma from "@/app/lib/prisma";
import {
  firstAllowedPage,
  hasPageAccess,
  pageHref,
  NO_ACCESS_HREF,
  type PageId,
} from "@/app/lib/page-access";

/**
 * Entrega C — Guarda server-side de acesso a uma página (colaboradores).
 *
 * Chamado nas páginas server LOGO APÓS o guard de sessão existente (que já
 * redireciona para /login), reaproveitando a mesma `session` (sem 2ª chamada a
 * getServerSession). Semântica:
 *  - Admin/superadmin (sem parentUserId) → acesso total, sem query extra.
 *  - Colaborador → LEITURA FRESCA de pagePermissions (efeito imediato quando o
 *    admin desliga a página; não depende do JWT, que só atualiza no relogin).
 *    Bloqueado → redireciona para a PRIMEIRA página liberada; se não houver
 *    nenhuma, para `/sem-acesso`.
 *
 * Por que não redireciona mais para "/" fixo: "/" é o Dashboard, que passou a
 * ser bloqueável. O alvo agora sai de `firstAllowedPage`, que já filtrou por
 * `hasPageAccess`, por `exclude` (a página recém-bloqueada) e por
 * `isPageRoutable` (feature flag). Logo o destino é, por construção, uma página
 * que não redireciona de volta — a cadeia tem no máximo um salto. E
 * `/sem-acesso` é terminal porque não é PageId, não está em PAGE_DEFS e não
 * chama esta função.
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

  const access = {
    parentUserId: fresh?.parentUserId ?? user.parentUserId,
    role: fresh?.role ?? user.role,
    pagePermissions:
      (fresh?.pagePermissions as Record<string, boolean> | null) ?? null,
  };

  if (hasPageAccess(access, pageId)) return;

  const alvo = firstAllowedPage(access, { exclude: pageId });
  redirect(alvo ? pageHref(alvo) : NO_ACCESS_HREF);
}
