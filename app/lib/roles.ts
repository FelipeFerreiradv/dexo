import type { Session } from "next-auth";

/**
 * Helpers de papel (role) compartilhados por front e server components.
 * `role` já flui na sessão (auth.ts → session.user.role). Comparação por string
 * literal ("SUPERADMIN") — não depende do enum Prisma, então funciona mesmo
 * antes do `prisma generate` que adiciona o valor ao tipo.
 */
export function isSuperadmin(
  session:
    | { user?: { role?: string | null } | null }
    | Session
    | null
    | undefined,
): boolean {
  return session?.user?.role === "SUPERADMIN";
}
