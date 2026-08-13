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

/**
 * ⭐ Libera quando o colaborador tem QUALQUER UMA das páginas listadas.
 *
 * ⚠️⚠️ EXISTE POR UM MOTIVO CONCRETO, e ignorá-lo quebra tela de gente que
 * trabalha. Alguns endpoints de LEITURA servem mais de uma página:
 *
 *   - `GET /customers` e `/customers/search` alimentam a lista de Clientes **e**
 *     o combobox de cliente do Financeiro/Orçamentos
 *     (financeiro/components/shared/customer-combobox.tsx:61-62);
 *   - `GET /scraps` alimenta a tela de Sucatas, o combobox de sucata do
 *     Financeiro (product-picker-block.tsx:693) **e** o vínculo de lote no
 *     cadastro de peça (create-product-dialog.tsx:1245).
 *
 * Barrá-los com `requirePageAccess("clientes")` / `("sucatas")` tiraria o
 * combobox de quem tem Financeiro e não tem Clientes — que é uma combinação
 * legítima e existente. Medido em produção em 12/08/2026: de 81 colaboradores,
 * 9 têm `sucatas: false` e 6 têm `clientes: false`.
 *
 * A garantia que continua valendo: quem não tem NENHUMA das páginas que usam o
 * endpoint não passa. Um colaborador só de Produtos não despeja a base de
 * clientes.
 *
 * ⚠️ Use só em LEITURA compartilhada. Mutação tem uma dona só — `POST /customers`
 * é da tela de Clientes e de mais ninguém, e ali vale `requirePageAccess`.
 */
export const requireAnyPageAccess =
  (pageIds: PageId[], opts?: { fresh?: boolean }) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    if (!user) return;
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
        // Falha de leitura não abre nem fecha o acesso por acidente.
      }
    }

    if (pageIds.some((p) => hasPageAccess(access, p))) return;

    return reply.status(403).send({
      message:
        "Seu acesso a esta área foi removido pelo administrador da conta.",
      code: "PAGE_FORBIDDEN",
      pageId: pageIds[0],
    });
  };
