import { FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { hasPageAccess, type PageId } from "../lib/page-access";

/**
 * Bloqueia na API o colaborador que não tem acesso a uma página.
 *
 * Sem isto o bloqueio seria cosmético: esconder o item no menu e barrar o
 * Server Component não impede um `curl` direto em `/dashboard/account-stats`
 * ou `/dashboard/report.pdf`, que expõem receita do período, receita por conta,
 * top produtos e o resumo de produtividade da equipe.
 *
 * Pré-requisito: `authMiddleware` roda antes e popula `request.user` — que já
 * inclui `pagePermissions` (ver `mapUser` em user.repository), então o caminho
 * padrão não custa nenhuma query extra.
 *
 * Frescor: `request.user` vem do cache de 60s do authMiddleware. É o MESMO
 * cache que já governa o bloqueio de conta inteira ("ao bloquear, sessões
 * ativas levam até 60s para serem barradas"), então exigir mais frescor aqui
 * seria mais rígido que o soft-disable de usuário. A camada navegacional
 * (`assertPageAccess`) continua lendo do banco a cada render, então o bloqueio
 * percebido pelo usuário é imediato. Use `{ fresh: true }` quando a rota
 * justificar a leitura direta.
 *
 * Zero regressão: admin/superadmin (sem parentUserId) e colaborador sem
 * `pagePermissions` gravado passam direto, exatamente como antes.
 */
export const requirePageAccess =
  (pageId: PageId, opts?: { fresh?: boolean }) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    // Sem usuário o authMiddleware já respondeu 401; não é papel deste hook.
    if (!user) return;
    // Admin/superadmin: nada a verificar, sem I/O.
    if (!user.parentUserId) return;

    let access = user;
    if (opts?.fresh) {
      try {
        const fresh = await prisma.user.findUnique({
          where: { id: user.id },
          select: { parentUserId: true, role: true, pagePermissions: true },
        });
        if (fresh) access = { ...user, ...fresh };
      } catch {
        // Falha de leitura não pode abrir nem fechar o acesso por acidente:
        // segue com o que o authMiddleware já tinha.
      }
    }

    if (hasPageAccess(access, pageId)) return;

    return reply.status(403).send({
      message:
        "Seu acesso a esta área foi removido pelo administrador da conta.",
      code: "PAGE_FORBIDDEN",
      pageId,
    });
  };
