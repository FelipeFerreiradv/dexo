import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FinanceUseCase } from "../usecases/finance.usecase";
import { FinanceKind, FinanceStatus } from "../interfaces/finance.interface";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireAction } from "../middlewares/require-action.middleware";
import { FinanceRepository } from "../repositories/finance.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { ReceiptPdfService } from "../financeiro/generators/receipt-pdf.service";
import { loadTenantAvatar } from "../fiscal/generators/load-avatar";
import prisma from "../lib/prisma";
import { resolveProductivityRange } from "../lib/team-productivity";
import {
  aggregateFinanceReport,
  type FinanceEntryInput,
  type FinanceStatusRaw,
} from "../lib/finance-report";
import { renderFinanceReport } from "../reports/finance-report";
import { FinanceStatus as PrismaFinanceStatus } from "@prisma/client";
import { parseCompanyIdParam } from "./fiscal.routes";
import { listSaleTimeline } from "../financeiro/lib/sale-timeline";
import { normalizeCancelReason } from "../financeiro/lib/cancel-reasons";
import { normalizeSellerId } from "../financeiro/lib/sale-seller";
import { normalizeSaleStage } from "../financeiro/lib/sale-stage";
import { normalizeBankAccountId } from "../financeiro/lib/bank-accounts";

/**
 * Fase 1.2 — contrato explícito do `PUT /finance/{receivables,payables}/:id`.
 *
 * Espelha `FinanceEntryCreate` menos `userId` (ou seja, `FinanceEntryUpdate`),
 * menos os dois campos governados por rotas próprias. Campo de fora da lista é
 * DESCARTADO; `PROTECTED_UPDATE_FIELDS` responde 400.
 *
 * Manter em sincronia com `FinanceEntryCreate` (finance.interface.ts): um campo
 * novo lá que não entre aqui é silenciosamente ignorado no update.
 */
export const UPDATABLE_FIELDS = new Set([
  "customerId",
  "newCustomer",
  "unidadeId",
  "document",
  "reason",
  "debtDetails",
  "totalAmount",
  "fineAmount",
  "finePercent",
  "interestPercent",
  "toleranceDays",
  "installments",
  "periodDays",
  "dueDate",
  "paymentMethod",
  "items",
  "payments",
  "installmentPlan",
]);

/** Só mudam por `POST /:id/pay` e `POST /:id/reverse`, que cuidam do estoque. */
export const PROTECTED_UPDATE_FIELDS = ["status", "paidAt"];

function fmtDateTimeBR(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

function toNum(x: unknown): number {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const anyx = x as { toNumber?: () => number };
  return typeof anyx.toNumber === "function" ? anyx.toNumber() : Number(x);
}

export const financeRoutes = async (fastify: FastifyInstance) => {
  const useCase = new FinanceUseCase();
  const financeRepo = new FinanceRepository();
  const companyFiscalRepo = new CompanyFiscalRepository();
  const receiptPdf = new ReceiptPdfService();

  fastify.get(
    "/summary",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { unidadeId, hasItems, customerId } = request.query as {
          unidadeId?: string;
          hasItems?: string;
          customerId?: string;
        };
        const summary = await useCase.summary(
          userId,
          unidadeId || undefined,
          // Só o literal "true" ativa (PDV); ausente/lixo => idêntico ao atual.
          hasItems === "true" ? true : undefined,
          // Bloco C: resumo de um cliente. Ausente => idêntico ao atual.
          customerId || undefined,
        );
        return reply.status(200).send({ summary });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao obter resumo",
        });
      }
    },
  );

  // Lookup de produto para a UI do financeiro (Fase 4 — venda balcão).
  // Mesmo contrato { results: ProductLookup[] } da rota fiscal de lookup;
  // delega ao FinanceUseCase.lookupProducts (que reusa NfeDraftUseCase) para
  // não duplicar a query e desacoplar a UI do prefixo /fiscal.
  fastify.get(
    "/products/lookup",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { q } = request.query as { q?: string };
        const results = await useCase.lookupProducts(userId, q || "");
        return reply.status(200).send({ results });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao buscar produtos",
        });
      }
    },
  );

  const buildListHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const {
          search,
          status,
          statusIn,
          customerId,
          unidadeId,
          paymentMethod,
          hasItems,
          from,
          to,
          page,
          limit,
        } = request.query as any;
        const data = await useCase.list(
          kind,
          {
            search: search || undefined,
            status: (status as FinanceStatus) || undefined,
            // BLOCO C — ausente/"" ⇒ não filtra ⇒ consulta idêntica à de hoje.
            statusIn: statusIn || undefined,
            customerId: customerId || undefined,
            unidadeId: unidadeId || undefined,
            paymentMethod: paymentMethod || undefined,
            // Só o literal "true" ativa o filtro (PDV); qualquer outro valor
            // (ausente/""/lixo) mantém o comportamento atual.
            hasItems: hasItems === "true" ? true : undefined,
            from: from || undefined,
            to: to || undefined,
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
          },
          userId,
        );
        return reply.status(200).send({
          items: data.items,
          pagination: {
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao listar registros",
        });
      }
    };

  // GET /:id — entry único COM itens (receivable). Usado pela edição para
  // carregar os itens já cadastrados (a lista NÃO os traz, por egress). Sem
  // isso, ao adicionar um item na edição o update faria "replace" e apagaria
  // os itens pré-existentes (perda de dados + total recalculado errado).
  const buildGetHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const entry = await useCase.findById(kind, id, userId);
        return reply.status(200).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar registro";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    };

  const buildCreateHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        // BLOCO B — o vendedor sai do spread e volta NORMALIZADO. Tirá-lo do
        // `...body` não é preciosismo: sem isso, com a flag desligada o valor
        // cru do formulário chegaria ao repositório assim mesmo, e a coluna
        // (que pode nem existir no banco ainda) seria escrita.
        const {
          sellerUserId: sellerBruto,
          bankAccountId: contaBruta,
          ...body
        } = (request.body ?? {}) as any;
        const sellerUserId =
          kind === "receivable" ? normalizeSellerId(sellerBruto) : undefined;
        // BLOCO A — conta de destino/origem. Vale para os DOIS kinds, e sai do
        // spread pelo mesmo motivo do vendedor: com a flag desligada o valor
        // cru chegaria ao repositório e tentaria escrever numa coluna que pode
        // não existir no banco ainda.
        const bankAccountId = normalizeBankAccountId(contaBruta);
        // BLOCO H — quem OPEROU (request.user.id), não o dono dos dados:
        // num tenant com colaboradores, dataOwnerId é sempre o admin.
        const entry = await useCase.create(
          kind,
          {
            ...body,
            userId,
            ...(sellerUserId !== undefined ? { sellerUserId } : {}),
            ...(bankAccountId !== undefined ? { bankAccountId } : {}),
          },
          {
            id: (request as any).user?.id,
            name: (request as any).user?.name ?? null,
          },
        );
        return reply.status(201).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar registro";
        const status = message.includes("Já existe")
          ? 409
          : message.includes("obrigatório") ||
              message.includes("inválido") ||
              message.includes("maior que")
            ? 400
            : message.includes("não encontrado")
              ? 404
              : 500;
        return reply.status(status).send({ error: message });
      }
    };

  const buildUpdateHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as Record<string, unknown>;

        // Fase 1.2 — o PUT repassava o body CRU ao usecase, e `updateSingle`
        // faz `{...data}` direto no `updateMany`. Na prática, qualquer coluna
        // escalar da tabela era gravável por HTTP.
        //
        // `status` e `paidAt` são os que causam dano de integridade e por isso
        // respondem 400, não silêncio: quem os manda está tentando cancelar ou
        // baixar por fora, e precisa saber que existe rota própria para isso.
        //  - `status: "CANCELADA"` cancelava a venda SEM devolver estoque, sem
        //    StockLog e sem reconciliar a sucata — e o `POST /reverse` legítimo
        //    virava no-op depois (a guarda de idempotência vê CANCELADA).
        //  - `status: "PAGA"` + `paidAt` contornava o `markPaid` inteiro: sem
        //    baixa de estoque, sem promoção de peça avulsa, sem `pauseOnZero`.
        //    Oversell silencioso no marketplace.
        const protegidos = PROTECTED_UPDATE_FIELDS.filter((f) => f in body);
        if (protegidos.length > 0) {
          return reply.status(400).send({
            error:
              `Campo(s) não editável(is) por esta rota: ${protegidos.join(", ")}. ` +
              `Use POST /${kind === "receivable" ? "receivables" : "payables"}/:id/pay para receber e ` +
              `POST /receivables/:id/reverse para cancelar.`,
          });
        }

        // O resto do que não é do contrato é DESCARTADO em silêncio (e não
        // rejeitado): o formulário reenvia campos de tela como `id`, que hoje
        // já eram inofensivos. Rejeitar quebraria a edição sem ganho nenhum.
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) {
          if (UPDATABLE_FIELDS.has(k)) data[k] = v;
        }

        // BLOCO B — vendedor. FORA da whitelist genérica de propósito: ela
        // vale para os dois kinds, e a coluna só existe em Receivable — um
        // `sellerUserId` num PUT de conta a pagar quebraria o update. Aqui o
        // campo entra normalizado e só no kind certo.
        //
        // `undefined` (chave ausente no formulário) NÃO vira `null`: seria um
        // PUT sem o campo apagando o vendedor de uma venda antiga.
        if (kind === "receivable") {
          const seller = normalizeSellerId(
            (body as Record<string, unknown>).sellerUserId,
          );
          if (seller !== undefined) data.sellerUserId = seller;
        }

        // BLOCO A — conta de destino/origem. Fora da whitelist genérica pela
        // mesma razão do vendedor (fronteira de tipo + flag), mas SEM o
        // recorte por kind: a coluna existe nos dois. `undefined` (chave
        // ausente) não vira `null` — seria um PUT sem o campo apagando a conta
        // de um lançamento que já a tinha.
        const conta = normalizeBankAccountId(
          (body as Record<string, unknown>).bankAccountId,
        );
        if (conta !== undefined) data.bankAccountId = conta;

        const entry = await useCase.update(kind, id, userId, data, {
          id: (request as any).user?.id,
          name: (request as any).user?.name ?? null,
        });
        return reply.status(200).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao atualizar";
        // BLOCO E — "Estornar" é a palavra que o DELETE de conta paga já usa
        // para sinalizar conflito de ESTADO (409), e não erro de entrada. O
        // ramo é aditivo: nenhuma mensagem anterior deste handler a contém,
        // então todo caminho existente continua caindo onde caía.
        const status = message.includes("não encontrado")
          ? 404
          : message.includes("Estornar")
            ? 409
            : 500;
        return reply.status(status).send({ error: message });
      }
    };

  const buildPayHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const entry = await useCase.markPaid(kind, id, userId, {
          id: (request as any).user?.id,
          name: (request as any).user?.name ?? null,
        });
        return reply.status(200).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao marcar como pago";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    };

  const buildDeleteHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        // Auditoria (Bloco E): registra quem operou, não o dono dos dados.
        await useCase.delete(kind, id, userId, {
          id: (request as any).user?.id,
          name: (request as any).user?.name ?? null,
        });
        return reply.status(200).send({ message: "Registro excluído" });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao excluir";
        // Fase 9: "Estornar" sinaliza guard de conta-paga-com-itens — 409.
        // Caminhos pré-existentes ("não encontrado" → 404, resto → 500)
        // permanecem.
        const status = message.includes("Estornar")
          ? 409
          : message.includes("não encontrado")
            ? 404
            : 500;
        return reply.status(status).send({ error: message });
      }
    };

  // Receivables
  fastify.get(
    "/receivables",
    { preHandler: [authMiddleware] },
    buildListHandler("receivable"),
  );
  fastify.post(
    "/receivables",
    { preHandler: [authMiddleware] },
    buildCreateHandler("receivable"),
  );
  fastify.get(
    "/receivables/:id",
    { preHandler: [authMiddleware] },
    buildGetHandler("receivable"),
  );
  fastify.put(
    "/receivables/:id",
    { preHandler: [authMiddleware] },
    buildUpdateHandler("receivable"),
  );
  fastify.post(
    "/receivables/:id/pay",
    { preHandler: [authMiddleware] },
    buildPayHandler("receivable"),
  );
  // Bloco E: excluir um título a receber é a mesma capacidade destrutiva que
  // cancelar a venda, então responde à MESMA permissão de ação. Payable segue
  // sem guard (fora de escopo). Default é permitir ⇒ nada muda para quem já
  // usa o sistema; só quem o admin desligar explicitamente recebe 403.
  fastify.delete(
    "/receivables/:id",
    { preHandler: [authMiddleware, requireAction("pdv.cancelar-venda")] },
    buildDeleteHandler("receivable"),
  );

  // ── Fase 9 — Estorno explícito (apenas receivable PAGA com itens) ──
  // Devolve o estoque (contra-lançamento) e reabre anúncios best-effort.
  // Idempotente: já CANCELADA → no-op. Atômico via $transaction com os
  // mesmos opts do markPaid ({timeout:60_000, maxWait:20_000}).
  //
  // Bloco E: protegido por permissão de AÇÃO. Esconder botão não é permissão —
  // sem o guard, um `curl` devolveria o estoque e cancelaria a venda igual.
  fastify.post(
    "/receivables/:id/reverse",
    { preHandler: [authMiddleware, requireAction("pdv.cancelar-venda")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        // BLOCO D — motivo OPCIONAL. O body pode não existir (o cliente só o
        // envia quando há motivo, para manter a requisição sem motivo
        // byte-idêntica à de hoje); `normalizeCancelReason` trata isso e
        // descarta código fora do vocabulário. Nada aqui pode IMPEDIR um
        // cancelamento — nem body inválido, nem observação gigante.
        const motivo = normalizeCancelReason(request.body);
        // Auditoria: quem OPEROU (request.user.id), não o dono dos dados —
        // num tenant com colaboradores, dataOwnerId é sempre o admin.
        const entry = await useCase.reverse(
          id,
          userId,
          {
            id: (request as any).user?.id,
            name: (request as any).user?.name ?? null,
          },
          motivo,
        );
        // Bloco B (aditivo): informa o que aconteceu com as parcelas. As em
        // aberto foram canceladas junto; as já RECEBIDAS ficaram como estão —
        // é dinheiro que entrou, e a devolução é decisão do operador. Sem
        // parcelas, o array vem vazio e a resposta é a de sempre + 1 campo.
        const filhas = await financeRepo.findChildren(id, userId);
        return reply.status(200).send({
          entry,
          installments: {
            cancelled: filhas.filter((f) => f.status === "CANCELADA").length,
            alreadyPaid: filhas.filter((f) => f.status === "PAGA").length,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao estornar";
        // "não encontrada" → 404; "inválida"/"inválido" (não-PAGA OU sem
        // itens) → 400; resto → 500.
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("inválida") || message.includes("inválido")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── BLOCO F — estágio operacional da venda ──
  //
  // Rota DEDICADA: o estágio muda muito (é operação de pátio) e não passa pelo
  // wizard nem pela guarda de edição do BLOCO E — venda PAGA continua andando
  // no pátio, é justamente aí que ela anda.
  //
  // Só receivable: o conceito é da VENDA. Conta a pagar não tem pipeline.
  fastify.patch<{ Params: { id: string }; Body: { saleStage?: unknown } }>(
    "/receivables/:id/stage",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        // Fronteira de tipo + flag numa só chamada: com a flag desligada
        // devolve `undefined` e a rota recusa, sem tocar a coluna nova (que
        // pode não existir no banco ainda).
        const saleStage = normalizeSaleStage((request.body ?? {}).saleStage);
        if (!saleStage) {
          // Ao contrário do motivo de cancelamento (acessório de uma operação
          // que precisa acontecer), aqui o estágio É a operação — recusar é a
          // resposta certa, não seguir em silêncio.
          return reply
            .status(400)
            .send({ error: "Estágio inválido ou recurso desativado" });
        }
        const entry = await useCase.setSaleStage(id, userId, saleStage, {
          id: (request as any).user?.id,
          name: (request as any).user?.name ?? null,
        });
        return reply.status(200).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao mover o estágio";
        const status = message.includes("não encontrada") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── BLOCO H — timeline da venda ──
  // Somente leitura, escopada por dataOwnerId no repositório (nunca no
  // caller). Paginada por cursor de data: uma venda muito editada não pode
  // virar payload sem fim. Com a flag desligada devolve [] — o que torna
  // seguro subir o código ANTES do DDL.
  fastify.get(
    "/receivables/:id/timeline",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const { limit, before } = request.query as {
          limit?: string;
          before?: string;
        };
        const antes = before ? new Date(before) : undefined;
        const events = await listSaleTimeline(id, userId, {
          limit: limit ? parseInt(limit) : undefined,
          before: antes && !isNaN(antes.getTime()) ? antes : undefined,
        });
        return reply.status(200).send({ events });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao consultar o histórico da venda",
        });
      }
    },
  );

  // ── Fase 8: Cupom fiscal real (NF-e modelo 55) — Opção A ──
  // Cria um rascunho de NF-e pré-preenchido a partir da Conta a Receber
  // (destinatário do customer, itens com defaults CFOP 5102 / origem 0 /
  // unidade UN / NCM em branco, pagamento DINHEIRO com valor total).
  // O cupom-PDF-sem-validade-fiscal abaixo continua intacto — esta é uma
  // operação adicional, não substituição.
  fastify.post(
    "/receivables/:id/fiscal-draft",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        // Multi-CNPJ: emitente opcional via QUERY (o POST segue sem body —
        // contrato do PDV pinado em teste). Ausente = CNPJ padrão. Fronteira
        // de tipo: query repetida (array) → 400, nunca erro interno.
        const companyId = parseCompanyIdParam(
          (request.query as { companyId?: unknown } | undefined)?.companyId,
        );
        if (companyId === undefined) {
          return reply.status(400).send({ error: "Emitente inválido" });
        }
        const draft = await useCase.createFiscalDraftFromReceivable(
          id,
          userId,
          companyId ? { companyFiscalConfigId: companyId } : undefined,
        );
        return reply.status(201).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao criar rascunho fiscal";
        // Mesma convenção de mapping do buildCreateHandler: "não encontrado"
        // → 404, "inválido"/"obrigatório" → 400, resto → 500.
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("não encontrado")
            ? 404
            : message.includes("inválida") || message.includes("inválido")
              ? 400
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── NFC-e em 1 clique (Fase 2 do PDV) — cria rascunho modelo 65 e EMITE ──
  // Chamada separada, DEPOIS do /pay: falha aqui nunca desfaz a venda.
  // Idempotente por venda (numeroPedido="receivable:<id>" + modelo 65).
  fastify.post(
    "/receivables/:id/nfce",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        // Multi-CNPJ: emitente opcional via QUERY (o POST segue sem body —
        // contrato do PDV pinado em teste). Ausente = CNPJ padrão. Fronteira
        // de tipo: query repetida (array) → 400, nunca erro interno.
        const companyId = parseCompanyIdParam(
          (request.query as { companyId?: unknown } | undefined)?.companyId,
        );
        if (companyId === undefined) {
          return reply.status(400).send({ error: "Emitente inválido" });
        }
        const nfce = await useCase.emitNfceFromReceivable(id, userId, companyId);
        return reply.status(200).send({ nfce });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao emitir NFC-e";
        // Convenção do fiscal-draft + regras próprias da NFC-e:
        // limite de valor → 422; pré-requisito de configuração → 400.
        const status = message.includes("R$ 10.000")
          ? 422
          : message.includes("não encontrada") ||
              message.includes("não encontrado")
            ? 404
            : message.includes("inválida") ||
                message.includes("inválido") ||
                message.includes("configurado") ||
                message.includes("configuracao fiscal")
              ? 400
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Bloco D: notas fiscais já vinculadas a esta venda (leitura pura) ──
  // Alimenta o menu "Ações" do livro do dia: com nota autorizada, "Emitir"
  // vira "Reimprimir"; em processamento, vira "Consultar". Sem isto o botão
  // de emitir seria um tiro no escuro sobre uma nota que já existe.
  //
  // ROTA NOVA — nenhum contrato existente muda. Consulta escopada por
  // dataOwnerId dentro do repositório; id inexistente ou de outro tenant
  // simplesmente não casa o link textual e devolve lista vazia (sem
  // vazamento e sem custo de uma consulta extra de existência).
  fastify.get(
    "/receivables/:id/fiscal-docs",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const docs = await useCase.listFiscalDocsForReceivable(id, userId);
        return reply.status(200).send({ docs });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao consultar notas da venda",
        });
      }
    },
  );

  // ── Cupom sem validade fiscal (apenas Receivable) ──
  fastify.get(
    "/receivables/:id/receipt",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };

        // Queries independentes em paralelo — entry (com customer) e
        // company fiscal config são consultas desacopladas.
        const [entry, company] = await Promise.all([
          financeRepo.findById("receivable", id, userId),
          companyFiscalRepo.findByUserId(userId),
        ]);

        if (!entry) {
          return reply
            .status(404)
            .send({ error: "Conta a receber não encontrada" });
        }

        // EGRESS: a imagem de identidade só é resolvida DEPOIS do guard — um id
        // inexistente ou de outro tenant não paga leitura de arquivo nem
        // requisição de rede. `loadTenantAvatar` é cacheado por tenant e nunca
        // lança: falha ⇒ null ⇒ cupom sai com as iniciais da razão social.
        const avatar = await loadTenantAvatar(prisma as never, userId);

        // Bloco B — parcelas da venda, para o cupom fechar a aritmética: a
        // conta-mãe carrega TODOS os itens mas seu totalAmount é só a entrada.
        // Sem isto o cupom sai com itens de R$ 131,11 e TOTAL de R$ 50,00.
        // Uma consulta indexada; venda à vista devolve [] e o cupom é o de
        // sempre (a chamada abaixo mantém a aridade original nesse caso).
        const filhas = await financeRepo.findChildren(id, userId);

        const pdfBytes =
          filhas.length > 0
            ? await receiptPdf.generate(
                entry,
                company,
                avatar,
                filhas.map((f) => ({
                  numero: f.installmentNumber ?? 0,
                  total: f.installmentTotal ?? filhas.length,
                  dueDate: f.dueDate,
                  amount: f.totalAmount,
                })),
              )
            : await receiptPdf.generate(entry, company, avatar);
        const buffer = Buffer.from(pdfBytes);

        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="cupom-${id}.pdf"`,
          )
          .header("Cache-Control", "private, no-store")
          .send(buffer);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao emitir cupom sem validade fiscal",
        });
      }
    },
  );

  // Payables
  fastify.get(
    "/payables",
    { preHandler: [authMiddleware] },
    buildListHandler("payable"),
  );
  fastify.post(
    "/payables",
    { preHandler: [authMiddleware] },
    buildCreateHandler("payable"),
  );
  fastify.get(
    "/payables/:id",
    { preHandler: [authMiddleware] },
    buildGetHandler("payable"),
  );
  fastify.put(
    "/payables/:id",
    { preHandler: [authMiddleware] },
    buildUpdateHandler("payable"),
  );
  fastify.post(
    "/payables/:id/pay",
    { preHandler: [authMiddleware] },
    buildPayHandler("payable"),
  );
  fastify.delete(
    "/payables/:id",
    { preHandler: [authMiddleware] },
    buildDeleteHandler("payable"),
  );

  /**
   * GET /finance/report.pdf
   * Relatório PDF (A4) do período: contas a pagar, a receber e VENDA BALCÃO
   * (conta a receber COM itens). Escopo = dono (dataOwnerId), respeita o filtro
   * de unidade. Período por `createdAt` (lançamentos do período); a situação
   * (recebido/pendente/vencido) é recalculada no momento, igual ao FinanceUseCase.
   * Querystring: startDate, endDate ("YYYY-MM-DD"/ISO; default 30 dias), unidadeId.
   * Leitura PURA + render @react-pdf; streama como download.
   */
  fastify.get(
    "/report.pdf",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string | undefined;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }
        const q = request.query as Record<string, string | undefined>;
        const range = resolveProductivityRange(q.startDate, q.endDate);
        const unidadeId = q.unidadeId || undefined;

        const whereBase = {
          userId,
          status: { not: PrismaFinanceStatus.CANCELADA },
          createdAt: { gte: range.startDate, lte: range.endDate },
          ...(unidadeId ? { unidadeId } : {}),
        };

        const [receivables, payables, owner] = await Promise.all([
          prisma.receivable.findMany({
            where: whereBase,
            select: {
              totalAmount: true,
              status: true,
              dueDate: true,
              paymentMethod: true,
              createdAt: true,
              // Bloco B: distingue a PARCELA de uma venda (que é balcão) de
              // uma cobrança avulsa. NULL em toda linha pré-existente.
              parentReceivableId: true,
              _count: { select: { items: true } },
            },
          }),
          prisma.payable.findMany({
            where: whereBase,
            select: {
              totalAmount: true,
              status: true,
              dueDate: true,
              paymentMethod: true,
              createdAt: true,
            },
          }),
          prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, email: true },
          }),
        ]);

        const mapEntry = (
          e: {
            totalAmount: unknown;
            status: string;
            dueDate: Date;
            paymentMethod: string | null;
            createdAt: Date;
            // Só receivable tem; payable nunca (Bloco B é receivable-only).
            parentReceivableId?: string | null;
          },
          hasItems?: boolean,
        ): FinanceEntryInput => ({
          totalAmount: toNum(e.totalAmount),
          status: e.status as FinanceStatusRaw,
          dueDate: e.dueDate,
          paymentMethod: e.paymentMethod,
          createdAt: e.createdAt,
          hasItems,
        });

        const result = aggregateFinanceReport(
          // Bloco B: a PARCELA de uma venda de balcão não tem itens, mas é
          // receita de balcão. Sem o OR, o saldo parcelado migraria para
          // "avulso" e o canal Balcão apareceria sub-reportado. Espelha o SQL
          // de dashboard-breakdowns.query.ts — os dois têm de mover juntos.
          receivables.map((r) =>
            mapEntry(
              r,
              (r._count?.items ?? 0) > 0 || r.parentReceivableId != null,
            ),
          ),
          payables.map((p) => mapEntry(p)),
          range,
          new Date(),
        );

        const pdf = await renderFinanceReport({
          company: owner?.name || owner?.email || "Sua empresa",
          generatedAtLabel: fmtDateTimeBR(new Date()),
          range: {
            startDate: range.startDate.toISOString(),
            endDate: range.endDate.toISOString(),
            label: range.label,
          },
          result,
        });

        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            'attachment; filename="relatorio-financeiro-dexo.pdf"',
          )
          .send(pdf);
      } catch (error) {
        console.error("Erro finance report:", error);
        return reply.status(500).send({ error: "Erro ao gerar o relatório" });
      }
    },
  );
};
