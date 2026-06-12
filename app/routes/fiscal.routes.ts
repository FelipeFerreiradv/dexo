import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { CompanyFiscalUseCase } from "../usecases/company-fiscal.usecase";
import { NfeDraftUseCase } from "../usecases/nfe-draft.usecase";
import { NfeEmissionUseCase } from "../usecases/nfe-emission.usecase";
import { NfeListingUseCase } from "../usecases/nfe-listing.usecase";
import { NfeCancelamentoUseCase } from "../usecases/nfe-cancelamento.usecase";
import { NfeInutilizacaoUseCase } from "../usecases/nfe-inutilizacao.usecase";
import { NfeCartaCorrecaoUseCase } from "../usecases/nfe-carta-correcao.usecase";
import { FiscalCalculatorService } from "../fiscal/calculators/fiscal-calculator.service";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { NfeRepository } from "../repositories/nfe.repository";
import { FiscalStorageService } from "../fiscal/storage/fiscal-storage.service";
import { NfeSequenceService } from "../fiscal/sequence/nfe-sequence.service";
import { createNfeProvider } from "../fiscal/providers/provider-factory";
import { extractCnpjFromCert } from "../fiscal/certificate/certificate-loader.service";
import type {
  FiscalAmbiente,
  NfeItemInput,
  RegimeTributario,
} from "../fiscal/domain/nfe.types";

/**
 * Remove segredos do CompanyFiscalConfig antes de devolver ao cliente e deriva
 * os campos que a UI precisa:
 *   - certificadoSenhaEnc / certificadoPath: segredos/infra — nunca ao navegador.
 *   - providerToken: segredo da API Focus — exposto só como booleano
 *     `providerTokenConfigurado` (o form reenvia vazio = preserva o salvo).
 *   - certificadoConfigurado: booleano de presença do A1.
 *   - certificadoCnpjConfirmado: reconfere o CNPJ do cert (do CN persistido)
 *     contra o emissor, para o aviso de risco sobreviver a um reload.
 */
function sanitizeFiscalConfig(
  config: Awaited<ReturnType<CompanyFiscalUseCase["getByUserId"]>> | null,
): Record<string, unknown> | null {
  if (!config) return null;

  // Tri-state: null = desconhecido (sem cert, ou cert antigo cadastrado antes
  // de persistirmos o CN — não alarma); true = CNPJ do cert confere; false =
  // CN presente mas o CNPJ não pôde ser confirmado (alarma e sobrevive a reload).
  let certificadoCnpjConfirmado: boolean | null = null;
  if (config.certificadoPath && config.certificadoSubjectCN) {
    const certCnpj = extractCnpjFromCert(config.certificadoSubjectCN);
    const emitter = (config.cnpj ?? "").replace(/\D/g, "");
    certificadoCnpjConfirmado = Boolean(
      certCnpj && emitter && certCnpj.slice(0, 8) === emitter.slice(0, 8),
    );
  }

  const safe: Record<string, unknown> = {
    ...config,
    certificadoConfigurado: Boolean(config.certificadoPath),
    certificadoCnpjConfirmado,
    providerTokenConfigurado: Boolean(config.providerToken),
  };
  delete safe.certificadoSenhaEnc;
  delete safe.certificadoPath;
  delete safe.providerToken;
  return safe;
}

export const fiscalRoutes = async (fastify: FastifyInstance) => {
  const companyFiscal = new CompanyFiscalUseCase();
  const nfeDraft = new NfeDraftUseCase();
  const nfeEmission = new NfeEmissionUseCase();
  const nfeListing = new NfeListingUseCase();
  const nfeCancelamento = new NfeCancelamentoUseCase();
  const nfeInutilizacao = new NfeInutilizacaoUseCase();
  const nfeCartaCorrecao = new NfeCartaCorrecaoUseCase();
  const calculator = new FiscalCalculatorService();
  const configRepo = new CompanyFiscalRepository();
  const nfeRepo = new NfeRepository();
  const storage = new FiscalStorageService();
  const nfeSequence = new NfeSequenceService();

  // ── Configuração ──

  fastify.get(
    "/config",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const config = await companyFiscal.getByUserId(userId);
        return reply.status(200).send({ config: sanitizeFiscalConfig(config) });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar configuração fiscal",
        });
      }
    },
  );

  fastify.put(
    "/config",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const body = request.body as any;
        const config = await companyFiscal.upsert(userId, body);
        return reply.status(200).send({ config: sanitizeFiscalConfig(config) });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao salvar configuração fiscal";
        const status =
          message.includes("inválid") ||
          message.includes("obrigat") ||
          message.includes("bloqueado") ||
          message.includes("dígitos")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // Upload do certificado digital A1 (.pfx) para o provedor SEFAZ_DIRECT.
  // Recebe multipart: campo `certificate` (arquivo .pfx) + campo `senha`.
  fastify.post(
    "/config/certificate",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!request.isMultipart()) {
          return reply.status(400).send({
            error: "Envie o certificado como multipart/form-data.",
          });
        }
        const userId = (request as any).user?.dataOwnerId as string;

        let buffer: Buffer | null = null;
        let filename = "";
        let senha = "";

        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "certificate") {
              // Drena outros arquivos para liberar o stream.
              await part.toBuffer().catch(() => undefined);
              continue;
            }
            filename = part.filename ?? "";
            try {
              buffer = await part.toBuffer();
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              if (/(FST_FILES_LIMIT|FST_REQ_FILE_TOO_LARGE)/.test(msg)) {
                return reply.status(400).send({
                  error: "Arquivo muito grande. O limite é 5MB.",
                });
              }
              throw e;
            }
          } else if (part.type === "field" && part.fieldname === "senha") {
            senha =
              typeof part.value === "string" ? part.value : String(part.value);
          }
        }

        if (!buffer) {
          return reply.status(400).send({
            error: "Nenhum arquivo enviado no campo `certificate`.",
          });
        }
        const lower = filename.toLowerCase();
        if (!lower.endsWith(".pfx") && !lower.endsWith(".p12")) {
          return reply.status(400).send({
            error: "Formato inválido. Envie um certificado A1 (.pfx ou .p12).",
          });
        }

        const result = await companyFiscal.uploadCertificate(
          userId,
          buffer,
          senha,
        );
        if (!result.ok) {
          return reply
            .status(result.status ?? 400)
            .send({ error: result.error });
        }
        return reply.status(200).send({
          success: true,
          subjectCN: result.subjectCN ?? null,
          certCnpj: result.certCnpj ?? null,
          validoAte: result.validoAte ?? null,
          cnpjMatched: result.cnpjMatched ?? false,
        });
      } catch (error) {
        request.log?.error?.(error);
        // Limites do multipart (ex.: muitas partes) lançados pelo próprio
        // iterador escapam o try interno: mapeamos para 413 em vez de 500.
        const code = (error as { code?: string })?.code ?? "";
        if (/FST_(PARTS|FIELDS|FILES)_LIMIT|FST_REQ_FILE_TOO_LARGE/.test(code)) {
          return reply.status(413).send({
            error: "Requisição excede os limites de upload (tamanho/quantidade).",
          });
        }
        // Não ecoamos a mensagem crua (pode vazar caminho do storage / detalhes
        // do Prisma). O erro real já foi logado acima para diagnóstico.
        return reply.status(500).send({
          error: "Erro ao processar o certificado. Tente novamente.",
        });
      }
    },
  );

  // ── Rascunho NFe ──

  // Preview (read-only) do próximo número para a série/ambiente — apenas
  // visualização; o número definitivo é reservado atomicamente na emissão.
  fastify.get(
    "/nfe/proximo-numero",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const raw = (request.query as { serie?: string } | undefined)?.serie;
        const serie = Number(raw);
        if (!Number.isInteger(serie) || serie < 0 || serie > 999) {
          return reply.status(400).send({ error: "Série inválida (0–999)." });
        }
        const config = await companyFiscal.getByUserId(userId);
        if (!config) {
          return reply
            .status(409)
            .send({ error: "Configuração fiscal não encontrada." });
        }
        const ambiente = config.ambiente as FiscalAmbiente;
        const proximoNumero = await nfeSequence.consultarProximoNumero(
          userId,
          ambiente,
          serie,
        );
        return reply.status(200).send({ serie, ambiente, proximoNumero });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao consultar próximo número",
        });
      }
    },
  );

  fastify.post(
    "/nfe/draft",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const body = (request.body as any) ?? {};
        const draft = await nfeDraft.create(userId, {
          orderId: body.orderId ?? null,
          customerId: body.customerId ?? null,
        });
        return reply.status(201).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar rascunho";
        const status = message.includes("Configuração fiscal") ? 400 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.get(
    "/nfe/draft/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const draft = await nfeDraft.getById(userId, id);
        return reply.status(200).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar rascunho";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.put(
    "/nfe/draft/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const body = request.body as any;
        const draft = await nfeDraft.update(userId, id, body);
        return reply.status(200).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao atualizar rascunho";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.delete(
    "/nfe/draft/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        await nfeDraft.delete(userId, id);
        return reply.status(204).send();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao excluir rascunho";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Calculate ──

  fastify.post(
    "/nfe/draft/:id/calculate",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;

        // Load draft with items
        const draft = await nfeDraft.getById(userId, id);
        if (!draft.itens || draft.itens.length === 0) {
          return reply
            .status(400)
            .send({ error: "Adicione pelo menos um produto antes de calcular" });
        }

        // Get regime from fiscal config
        const config = await configRepo.findByUserId(userId);
        if (!config) {
          return reply
            .status(400)
            .send({ error: "Configuracao fiscal nao encontrada" });
        }

        const regime = config.regimeTributario as RegimeTributario;

        // Validate items have required fiscal fields
        for (let i = 0; i < draft.itens.length; i++) {
          const it = draft.itens[i];
          if (!it.ncm || it.ncm.trim().length === 0) {
            return reply.status(400).send({
              error: `Item ${i + 1} ("${it.descricao}") esta sem NCM. Preencha o NCM antes de calcular.`,
            });
          }
          if (!it.cfop || it.cfop.trim().length === 0) {
            return reply.status(400).send({
              error: `Item ${i + 1} ("${it.descricao}") esta sem CFOP. Preencha o CFOP antes de calcular.`,
            });
          }
        }

        // Map draft items to calculator input
        const itensInput: NfeItemInput[] = draft.itens.map((item) => ({
          quantidade: Number(item.quantidade),
          valorUnitario: Number(item.valorUnitario),
          desconto: Number(item.desconto ?? 0),
          ncm: item.ncm,
          cfop: item.cfop,
          origem: (item.origem ?? 0) as any,
          cstIcms: item.cstIcms ?? (regime === "SIMPLES" ? "102" : "00"),
          cstPis: (item.cstPis ?? (regime === "SIMPLES" ? "49" : "01")) as any,
          cstCofins: (item.cstCofins ?? (regime === "SIMPLES" ? "49" : "01")) as any,
          aliquotaIcms: item.aliquotaIcms ?? null,
          aliquotaIpi: item.aliquotaIpi ?? null,
          aliquotaPis: item.aliquotaPis ?? null,
          aliquotaCofins: item.aliquotaCofins ?? null,
          reducaoBcIcms: item.reducaoBcIcms ?? null,
        }));

        const result = calculator.calcular(regime, itensInput);

        // Persist totais to the draft
        await nfeRepo.updateDraft(userId, id, {
          totaisJson: result.totais,
        });

        return reply.status(200).send({ totais: result.totais, itens: result.itens });
      } catch (error) {
        console.error("[fiscal/calculate] Error:", error);
        const message =
          error instanceof Error ? error.message : "Erro ao calcular impostos";
        return reply.status(500).send({ error: message });
      }
    },
  );

  // ── Lookups ──

  fastify.get(
    "/lookup/customers",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Querystring: { q?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const q = (request.query as any).q || "";
        const results = await nfeDraft.lookupCustomers(userId, q);
        return reply.status(200).send({ results });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar clientes",
        });
      }
    },
  );

  fastify.get(
    "/lookup/products",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Querystring: { q?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const q = (request.query as any).q || "";
        const results = await nfeDraft.lookupProducts(userId, q);
        return reply.status(200).send({ results });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar produtos",
        });
      }
    },
  );

  // ── Emissão ──

  fastify.post(
    "/nfe/:id/issue",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const result = await nfeEmission.emit(userId, id);
        return reply.status(200).send(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao emitir NF-e";
        const status =
          message.includes("nao encontrad") ||
          message.includes("não encontrad")
            ? 404
            : message.includes("incompleto") ||
                message.includes("obrigat") ||
                message.includes("invalid") ||
                message.includes("sem NCM") ||
                message.includes("sem CFOP") ||
                message.includes("nao esta em rascunho") ||
                message.includes("Token")
              ? 400
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Listagem de notas emitidas (F6) ──

  fastify.get(
    "/nfe",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const q = request.query as any;
        const result = await nfeListing.list(userId, {
          page: Number(q.page) || 1,
          limit: Number(q.limit) || 10,
          search: q.search,
          status: q.status,
          serie: q.serie ? Number(q.serie) : undefined,
          ambiente: q.ambiente,
          dataInicio: q.dataInicio,
          dataFim: q.dataFim,
        });
        return reply.status(200).send(result);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao listar notas fiscais",
        });
      }
    },
  );

  fastify.get(
    "/nfe/stats",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const stats = await nfeListing.stats(userId);
        return reply.status(200).send({ stats });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar estatisticas",
        });
      }
    },
  );

  fastify.get(
    "/nfe/export",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const q = request.query as any;
        const format = q.format === "pdf" ? "pdf" : "xlsx";
        const buffer = await nfeListing.exportData(
          userId,
          {
            status: q.status,
            dataInicio: q.dataInicio,
            dataFim: q.dataFim,
          },
          format as "xlsx" | "pdf",
        );

        if (format === "pdf") {
          return reply
            .header("Content-Type", "application/pdf")
            .header(
              "Content-Disposition",
              'attachment; filename="notas-fiscais.pdf"',
            )
            .send(buffer);
        }
        return reply
          .header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .header(
            "Content-Disposition",
            'attachment; filename="notas-fiscais.xlsx"',
          )
          .send(buffer);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao exportar dados",
        });
      }
    },
  );

  // ── Relatório mensal consolidado (XML) — read-only, para o contador ──

  fastify.get(
    "/nfe/relatorio-mensal",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const q = request.query as any;
        const ano = Number(q.ano);
        const mes = Number(q.mes);
        if (!Number.isInteger(ano) || ano < 2006 || ano > 2099) {
          return reply
            .status(400)
            .send({ error: "Parametro 'ano' invalido (2006-2099)" });
        }
        if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
          return reply
            .status(400)
            .send({ error: "Parametro 'mes' invalido (1-12)" });
        }

        const { xml } = await nfeListing.relatorioMensalXml(userId, ano, mes);
        const mes2 = String(mes).padStart(2, "0");
        return reply
          .header("Content-Type", "application/xml; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="relatorio-nfe-${ano}-${mes2}.xml"`,
          )
          .send(xml);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao gerar relatorio mensal",
        });
      }
    },
  );

  // ── Consulta de NF-e (qualquer status) ──

  fastify.get(
    "/nfe/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const row = await (prisma as any).nfeEmitida.findFirst({
          where: { id, userId },
          include: {
            itens: { orderBy: { numero: "asc" } },
            eventos: { orderBy: { createdAt: "desc" }, take: 20 },
          },
        });
        if (!row) {
          return reply.status(404).send({ error: "NF-e nao encontrada" });
        }
        return reply.status(200).send({ nfe: row });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar NF-e",
        });
      }
    },
  );

  // ── Download XML autorizado ──

  fastify.get(
    "/nfe/:id/xml",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const row = await (prisma as any).nfeEmitida.findFirst({
          where: { id, userId },
          select: { xmlAutorizadoPath: true, xmlOriginalPath: true, numero: true, serie: true },
        });
        if (!row) {
          return reply.status(404).send({ error: "NF-e nao encontrada" });
        }
        const filePath = row.xmlAutorizadoPath || row.xmlOriginalPath;
        if (!filePath) {
          return reply.status(404).send({ error: "XML nao disponivel" });
        }
        const content = await storage.readFile(filePath);
        if (!content) {
          return reply.status(404).send({ error: "Arquivo XML nao encontrado" });
        }
        return reply
          .header("Content-Type", "application/xml")
          .header(
            "Content-Disposition",
            `attachment; filename="nfe-${row.serie}-${row.numero}.xml"`,
          )
          .send(content);
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "Erro ao baixar XML",
        });
      }
    },
  );

  // ── Download DANFE PDF ──

  fastify.get(
    "/nfe/:id/danfe",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const row = await (prisma as any).nfeEmitida.findFirst({
          where: { id, userId },
          select: { danfePdfPath: true, numero: true, serie: true },
        });
        if (!row) {
          return reply.status(404).send({ error: "NF-e nao encontrada" });
        }
        if (!row.danfePdfPath) {
          return reply.status(404).send({ error: "DANFE nao disponivel" });
        }
        const content = await storage.readFile(row.danfePdfPath);
        if (!content) {
          return reply.status(404).send({ error: "Arquivo DANFE nao encontrado" });
        }
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="danfe-${row.serie}-${row.numero}.pdf"`,
          )
          .send(content);
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "Erro ao baixar DANFE",
        });
      }
    },
  );

  // ── Histórico de eventos ──

  fastify.get(
    "/nfe/:id/events",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        // Verify ownership
        const nfe = await (prisma as any).nfeEmitida.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!nfe) {
          return reply.status(404).send({ error: "NF-e nao encontrada" });
        }
        const events = await (prisma as any).nfeAuditLog.findMany({
          where: { nfeId: id },
          orderBy: { createdAt: "desc" },
        });
        return reply.status(200).send({ events });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar eventos",
        });
      }
    },
  );

  // ── Cancelamento de NF-e (F7a) ──

  fastify.post(
    "/nfe/:id/cancel",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const body = request.body as any;
        const justificativa = body?.justificativa ?? "";
        const result = await nfeCancelamento.cancel(userId, id, justificativa);
        return reply.status(result.success ? 200 : 422).send(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao cancelar NF-e";
        const status =
          message.includes("nao encontrada")
            ? 404
            : message.includes("obrigat") ||
                message.includes("autorizadas") ||
                message.includes("expirado") ||
                message.includes("sem chave") ||
                message.includes("sem protocolo")
              ? 400
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Carta de Correção Eletrônica (F-F) ──
  //
  // Só funciona com providerName=SEFAZ_DIRECT (Focus NFe não expõe via API).
  // Body: { correcao: string }. Retorno inclui sequencia atribuída (1..20).

  fastify.post(
    "/nfe/:id/carta-correcao",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const body = request.body as any;
        const correcao = body?.correcao ?? "";
        const result = await nfeCartaCorrecao.execute(userId, id, correcao);
        return reply.status(result.success ? 200 : 422).send(result);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao enviar Carta de Correcao";
        const status =
          message.includes("nao encontrada")
            ? 404
            : message.includes("Limite") ||
                message.includes("15..1000") ||
                message.includes("Somente NFes") ||
                message.includes("sem chave") ||
                message.includes("SEFAZ_DIRECT") ||
                message.includes("certificado")
              ? 400
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Inutilização de numeração (F7a) ──

  fastify.post(
    "/inutilizacao",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const body = request.body as any;
        const result = await nfeInutilizacao.inutilizar(userId, {
          serie: Number(body.serie),
          numeroInicial: Number(body.numeroInicial),
          numeroFinal: Number(body.numeroFinal),
          justificativa: body.justificativa ?? "",
        });
        return reply.status(result.success ? 200 : 422).send(result);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao inutilizar numeracao";
        const status =
          message.includes("obrigat") ||
          message.includes("maior que zero") ||
          message.includes("menor ou igual")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.get(
    "/inutilizacao",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const items = await nfeInutilizacao.list(userId);
        return reply.status(200).send({ items });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao listar inutilizacoes",
        });
      }
    },
  );

  // ── Envio de XML por e-mail (F7b) ──

  fastify.post(
    "/nfe/:id/resend-email",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        if (process.env.EMAIL_ENABLED !== "true") {
          return reply.status(501).send({
            error: "Envio de e-mail desabilitado (EMAIL_ENABLED=false)",
          });
        }

        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params;
        const body = request.body as any;
        const email = body?.email;

        if (!email || typeof email !== "string" || !email.includes("@")) {
          return reply
            .status(400)
            .send({ error: "E-mail de destino invalido" });
        }

        // Load NF-e
        const nfe = await (prisma as any).nfeEmitida.findFirst({
          where: { id, userId },
          select: {
            id: true,
            numero: true,
            serie: true,
            status: true,
            chaveAcesso: true,
            xmlAutorizadoPath: true,
            xmlOriginalPath: true,
            danfePdfPath: true,
          },
        });

        if (!nfe) {
          return reply.status(404).send({ error: "NF-e nao encontrada" });
        }
        if (nfe.status !== "AUTHORIZED" && nfe.status !== "CANCELLED") {
          return reply.status(400).send({
            error: "Somente notas autorizadas ou canceladas podem ser enviadas por e-mail",
          });
        }

        // Lazy-import email service
        const { EmailService } = await import("../services/email.service");
        const emailService = new EmailService();

        // Build attachments
        const attachments: Array<{ filename: string; content: Buffer }> = [];
        const xmlPath = nfe.xmlAutorizadoPath || nfe.xmlOriginalPath;
        if (xmlPath) {
          const xmlContent = await storage.readFile(xmlPath);
          if (xmlContent) {
            attachments.push({
              filename: `nfe-${nfe.serie}-${nfe.numero}.xml`,
              content: typeof xmlContent === "string" ? Buffer.from(xmlContent) : xmlContent,
            });
          }
        }
        if (nfe.danfePdfPath) {
          const pdfContent = await storage.readFile(nfe.danfePdfPath);
          if (pdfContent) {
            attachments.push({
              filename: `danfe-${nfe.serie}-${nfe.numero}.pdf`,
              content: typeof pdfContent === "string" ? Buffer.from(pdfContent) : pdfContent,
            });
          }
        }

        await emailService.send({
          to: email,
          subject: `NF-e ${nfe.serie}/${nfe.numero} - ${nfe.chaveAcesso ?? ""}`,
          text: `Segue em anexo a NF-e numero ${nfe.numero}, serie ${nfe.serie}.\n\nChave de acesso: ${nfe.chaveAcesso ?? "N/A"}`,
          attachments,
        });

        await nfeRepo.addAuditLog(id, userId, "XML_REENVIADO", {
          email,
          attachmentCount: attachments.length,
        });

        return reply.status(200).send({
          success: true,
          mensagem: `E-mail enviado para ${email}`,
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao enviar e-mail",
        });
      }
    },
  );
};
