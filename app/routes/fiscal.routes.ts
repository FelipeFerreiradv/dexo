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
/**
 * Teto de tamanho do XML aceito para re-render no download.
 *
 * `storage.readFile` + `parseNfeXml` + o desenho no pdf-lib são TODOS síncronos
 * — não existe `await` que devolva o event loop no meio. Um `Promise.race` com
 * timeout não preemptaria nada: a CPU já teria queimado inteira. O controle
 * real é recusar entrada grande antes de começar.
 *
 * O valor vem de medição, não de chute. O custo do render é LINEAR (~0,63 ms
 * por item) e o XML gasta ~700 B por item, então o teto converte direto em
 * tempo de event loop bloqueado:
 *
 *   512 KB ≈ 757 itens ≈ 480 ms bloqueados   (o teto anterior)
 *   128 KB ≈ 190 itens ≈ 120 ms bloqueados   (este)
 *
 * E 190 itens é folga de duas ordens de grandeza sobre a realidade: das 6.382
 * notas autorizadas/canceladas em produção, a MAIOR tem 2 itens e 100% têm ≤ 2.
 * Nenhuma nota real é afetada; o que muda é o pior caso de uma entrada
 * patológica (XML importado de outro sistema) travar o processo.
 */
const DANFE_RERENDER_MAX_XML_BYTES = 128 * 1024;

/**
 * Re-renderiza o DANFE a partir do XML autorizado, para que notas emitidas
 * ANTES do redesenho também saiam no layout novo.
 *
 * Estritamente best-effort e SEM exceções para fora: `generateFromXml` lança de
 * propósito para XML sem `protNFe` ou com `cStat` de rejeição (guard PAR-4), e
 * uma nota que hoje baixa não pode passar a dar erro por causa disto. Qualquer
 * problema ⇒ `null` ⇒ o chamador serve o PDF gravado em disco, como sempre.
 *
 * Fica atrás da MESMA flag do renderer novo: com ela desligada não faz sentido
 * pagar parse + render para entregar o layout antigo — e o kill-switch precisa
 * desligar as duas coisas de uma vez.
 */
export async function tryRerenderDanfe(
  storage: Pick<FiscalStorageService, "readFile">,
  xmlPath: string | null | undefined,
): Promise<Uint8Array | null> {
  if (!xmlPath) return null;
  if (process.env.NEXT_PUBLIC_DANFE_OFICIAL_ENABLED !== "true") return null;
  try {
    const raw = await storage.readFile(xmlPath);
    if (!raw) return null;
    // `readFile` devolve Buffer; `parseNfeXml` recusa qualquer coisa que não
    // seja string logo na primeira linha. Sem esta conversão o re-render vira
    // um no-op silencioso engolido pelo catch abaixo.
    const xml = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    if (!xml || Buffer.byteLength(xml, "utf8") > DANFE_RERENDER_MAX_XML_BYTES) {
      return null;
    }
    const { DanfePdfService } = await import(
      "../fiscal/generators/danfe-pdf.service"
    );
    return await new DanfePdfService().generateFromXml(xml);
  } catch {
    return null;
  }
}

export function sanitizeFiscalConfig(
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
    // NFC-e (Fase 2): o CSC é segredo — exposto só como booleano, mesmo
    // padrão do providerToken (form reenvia vazio = preserva o salvo).
    cscConfigurado: Boolean(config.cscToken),
  };
  delete safe.certificadoSenhaEnc;
  delete safe.certificadoPath;
  delete safe.providerToken;
  delete safe.cscToken;
  return safe;
}

/**
 * Lê o multipart de upload de certificado A1 (campo `certificate` + `senha`).
 * Extraído para a rota legada (/config/certificate) e a multi-CNPJ
 * (/companies/:id/certificate) compartilharem EXATAMENTE o mesmo parsing —
 * corpo copiado verbatim da rota original. Quando o payload é inválido, já
 * responde 400 e retorna null (o caller apenas retorna).
 */
async function readCertificateMultipart(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ buffer: Buffer; senha: string } | null> {
  if (!request.isMultipart()) {
    await reply.status(400).send({
      error: "Envie o certificado como multipart/form-data.",
    });
    return null;
  }

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
          await reply.status(400).send({
            error: "Arquivo muito grande. O limite é 20MB.",
          });
          return null;
        }
        throw e;
      }
    } else if (part.type === "field" && part.fieldname === "senha") {
      senha = typeof part.value === "string" ? part.value : String(part.value);
    }
  }

  if (!buffer) {
    await reply.status(400).send({
      error: "Nenhum arquivo enviado no campo `certificate`.",
    });
    return null;
  }
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".pfx") && !lower.endsWith(".p12")) {
    await reply.status(400).send({
      error: "Formato inválido. Envie um certificado A1 (.pfx ou .p12).",
    });
    return null;
  }

  return { buffer, senha };
}

/**
 * Fronteira de tipo p/ ids de emitente vindos de query/body: só string
 * não-vazia passa; null/ausente/"" viram null (= padrão); qualquer outro tipo
 * (array por repetição de query, objeto) retorna undefined = inválido, para a
 * rota responder 400 ANTES de o valor chegar ao Prisma — evita 500 com erro
 * interno ecoado. Clientes legítimos (string ou omissão) não mudam em nada.
 */
export function parseCompanyIdParam(v: unknown): string | null | undefined {
  if (v == null) return null;
  if (typeof v !== "string") return undefined; // inválido
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
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
        const userId = (request as any).user?.dataOwnerId as string;
        const parsed = await readCertificateMultipart(request, reply);
        if (!parsed) return reply; // resposta 400 já enviada pelo helper

        const result = await companyFiscal.uploadCertificate(
          userId,
          parsed.buffer,
          parsed.senha,
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

  // ── Multi-CNPJ: gestão de empresas (CNPJs) do tenant ──
  //
  // Rotas ADITIVAS: /config* continua operando sobre a empresa PADRÃO,
  // byte-idêntico. POST /companies (2º CNPJ em diante) é gated por
  // FISCAL_MULTI_CNPJ_ENABLED — só pode ligar após o SQL-2 do
  // docs/multi-cnpj-sql.md (antes, o unique antigo de numeração colidiria).

  const companyErrorStatus = (message: string): number => {
    if (message.includes("não encontrad")) return 404;
    if (
      message.includes("não pode ser removida") ||
      message.includes("em uso") ||
      message.includes("Já existe")
    )
      return 409;
    if (message.includes("não está habilitado")) return 403;
    if (
      message.includes("inválid") ||
      message.includes("obrigat") ||
      message.includes("bloqueado") ||
      message.includes("dígitos") ||
      message.includes("principal") ||
      message.includes("Limite de empresas")
    )
      return 400;
    return 500;
  };


  fastify.get(
    "/companies",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const companies = await companyFiscal.listByUserId(userId);

        // Egress: `?view=summary` devolve SÓ os campos que os seletores do
        // wizard/PDV usam (~6 campos vs ~30). Pick feito AQUI sobre a lista
        // completa — valores idênticos, mesma ordenação padrão-primeiro.
        // Sem o parâmetro (ou com valor diferente), resposta byte-idêntica.
        const view = (request.query as { view?: string } | undefined)?.view;
        if (view === "summary") {
          return reply.status(200).send({
            companies: companies.map((c) => ({
              id: c.id,
              cnpj: c.cnpj,
              razaoSocial: c.razaoSocial,
              nomeFantasia: c.nomeFantasia ?? null,
              isDefault: c.isDefault ?? false,
              serieNfe: c.serieNfe ?? 1,
            })),
          });
        }

        return reply.status(200).send({
          companies: companies.map((c) => sanitizeFiscalConfig(c)),
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao listar empresas",
        });
      }
    },
  );

  fastify.post(
    "/companies",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (process.env.FISCAL_MULTI_CNPJ_ENABLED !== "true") {
          return reply.status(403).send({
            error:
              "Cadastro de múltiplos CNPJs não está habilitado. Contate o suporte.",
          });
        }
        const userId = (request as any).user?.dataOwnerId as string;
        const body = request.body as any;
        const company = await companyFiscal.createSecondary(userId, body);
        return reply
          .status(201)
          .send({ company: sanitizeFiscalConfig(company) });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar empresa";
        return reply
          .status(companyErrorStatus(message))
          .send({ error: message });
      }
    },
  );

  fastify.put(
    "/companies/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const body = request.body as any;
        const company = await companyFiscal.updateById(id, userId, body);
        return reply
          .status(200)
          .send({ company: sanitizeFiscalConfig(company) });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao salvar empresa";
        return reply
          .status(companyErrorStatus(message))
          .send({ error: message });
      }
    },
  );

  fastify.put(
    "/companies/:id/default",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        await companyFiscal.setDefault(id, userId);
        return reply.status(200).send({ success: true });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao definir empresa padrão";
        return reply
          .status(companyErrorStatus(message))
          .send({ error: message });
      }
    },
  );

  fastify.delete(
    "/companies/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        await companyFiscal.deleteById(id, userId);
        return reply.status(200).send({ success: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao remover empresa";
        return reply
          .status(companyErrorStatus(message))
          .send({ error: message });
      }
    },
  );

  // Upload do certificado A1 de uma empresa específica — mesmo contrato
  // multipart da rota legada (/config/certificate), certificando o CNPJ DELA.
  fastify.post(
    "/companies/:id/certificate",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const parsed = await readCertificateMultipart(request, reply);
        if (!parsed) return reply; // resposta 400 já enviada pelo helper

        const result = await companyFiscal.uploadCertificate(
          userId,
          parsed.buffer,
          parsed.senha,
          id,
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
        const code = (error as { code?: string })?.code ?? "";
        if (/FST_(PARTS|FIELDS|FILES)_LIMIT|FST_REQ_FILE_TOO_LARGE/.test(code)) {
          return reply.status(413).send({
            error:
              "Requisição excede os limites de upload (tamanho/quantidade).",
          });
        }
        return reply.status(500).send({
          error: "Erro ao processar o certificado. Tente novamente.",
        });
      }
    },
  );

  // ── Multi-CNPJ: vínculo conta de marketplace → CNPJ emissor ──
  // O pedido dessa conta passa a emitir automaticamente pelo CNPJ vinculado
  // (precedência: escolha explícita > vínculo da conta > padrão).

  // Lista enxuta das contas do tenant p/ a tela de configuração fiscal.
  fastify.get(
    "/marketplace-accounts",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const accounts = await (prisma as any).marketplaceAccount.findMany({
          where: { userId },
          select: {
            id: true,
            platform: true,
            accountName: true,
            status: true,
            companyFiscalConfigId: true,
          },
          orderBy: [{ platform: "asc" }, { accountName: "asc" }],
        });
        return reply.status(200).send({ accounts });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao listar contas",
        });
      }
    },
  );

  fastify.put(
    "/marketplace-accounts/:accountId/company",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { accountId } = request.params as { accountId: string };
        const body = (request.body as any) ?? {};
        // Fronteira de tipo + normalização: "" e null significam o mesmo
        // ("usa o padrão") e gravam NULL; tipo inválido → 400 antes do Prisma.
        const companyId = parseCompanyIdParam(body.companyFiscalConfigId);
        if (companyId === undefined) {
          return reply.status(400).send({ error: "Emitente inválido" });
        }

        const account = await (prisma as any).marketplaceAccount.findFirst({
          where: { id: accountId, userId },
          select: { id: true },
        });
        if (!account) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
        if (companyId) {
          const company = await companyFiscal.getByIdForUser(
            companyId,
            userId,
          );
          if (!company) {
            return reply.status(404).send({ error: "Empresa não encontrada" });
          }
        }
        // Escrita ESCOPADA por tenant (padrão da casa: updateMany {id, userId}
        // — update simples por id não teria o escopo). count 0 só na corrida
        // conta-apagada-no-meio → mesmo 404 externo de sempre.
        const res = await (prisma as any).marketplaceAccount.updateMany({
          where: { id: accountId, userId },
          data: { companyFiscalConfigId: companyId },
        });
        if (res.count === 0) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
        return reply
          .status(200)
          .send({ success: true, companyFiscalConfigId: companyId });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao vincular conta",
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
        const query = request.query as
          | { serie?: string; companyId?: string }
          | undefined;
        const raw = query?.serie;
        const serie = Number(raw);
        if (!Number.isInteger(serie) || serie < 0 || serie > 999) {
          return reply.status(400).send({ error: "Série inválida (0–999)." });
        }
        // Multi-CNPJ: companyId opcional seleciona o emitente do preview.
        // Sem o parâmetro, resposta byte-idêntica à atual (config padrão).
        const companyId = parseCompanyIdParam(query?.companyId);
        if (companyId === undefined) {
          return reply.status(400).send({ error: "Emitente inválido" });
        }
        const config = companyId
          ? await companyFiscal.getByIdForUser(companyId, userId)
          : await companyFiscal.getByUserId(userId);
        if (!config) {
          return companyId
            ? reply.status(404).send({ error: "Empresa não encontrada." })
            : reply
                .status(409)
                .send({ error: "Configuração fiscal não encontrada." });
        }
        const ambiente = config.ambiente as FiscalAmbiente;
        // Sempre com opts: sem companyId o config é o PADRÃO (por definição),
        // e o filtro por emitente evita ler o contador de OUTRO CNPJ do
        // tenant. Para tenant de 1 CNPJ o número retornado é o mesmo de antes.
        const proximoNumero = await nfeSequence.consultarProximoNumero(
          userId,
          ambiente,
          serie,
          "55",
          {
            companyFiscalConfigId: config.id,
            isDefaultConfig: companyId ? (config.isDefault ?? true) : true,
          },
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
        // Multi-CNPJ: seleção explícita de emitente (opcional) — fronteira de
        // tipo antes do usecase (tipo inválido → 400, nunca erro interno).
        const draftCompanyId = parseCompanyIdParam(body.companyFiscalConfigId);
        if (draftCompanyId === undefined) {
          return reply.status(400).send({ error: "Emitente inválido" });
        }
        const draft = await nfeDraft.create(userId, {
          orderId: body.orderId ?? null,
          customerId: body.customerId ?? null,
          companyFiscalConfigId: draftCompanyId,
        });
        return reply.status(201).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar rascunho";
        const status = message.includes("Configuração fiscal")
          ? 400
          : message.includes("Emitente selecionado")
            ? 404
            : 500;
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
        // Multi-CNPJ: fronteira de tipo do emitente (quando enviado) — tipo
        // inválido → 400 antes do usecase/Prisma. Ausente segue ausente.
        if (body?.companyFiscalConfigId !== undefined) {
          const draftCompanyId = parseCompanyIdParam(body.companyFiscalConfigId);
          if (draftCompanyId === undefined) {
            return reply.status(400).send({ error: "Emitente inválido" });
          }
          body.companyFiscalConfigId = draftCompanyId;
        }
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
        // Multi-CNPJ: o regime é o do EMITENTE do draft (pode diferir entre
        // CNPJs do tenant). Draft sem emitente = era 1-CNPJ ⇒ padrão.
        const config = draft.companyFiscalConfigId
          ? await configRepo.findByIdForUser(draft.companyFiscalConfigId, userId)
          : await configRepo.findByUserId(userId);
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
          // Filtro por modelo (aditivo): só aceita "55"/"65"; qualquer outro
          // valor é ignorado e a listagem segue trazendo os dois.
          modelo: q.modelo === "55" || q.modelo === "65" ? q.modelo : undefined,
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

        // Multi-CNPJ: companyId opcional escolhe o emitente do relatório
        // (ausente = padrão; notas de outro CNPJ do tenant nunca entram).
        const companyId = parseCompanyIdParam(q.companyId);
        if (companyId === undefined) {
          return reply.status(400).send({ error: "Emitente inválido" });
        }
        const { xml } = await nfeListing.relatorioMensalXml(
          userId,
          ano,
          mes,
          companyId,
        );
        const mes2 = String(mes).padStart(2, "0");
        return reply
          .header("Content-Type", "application/xml; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="relatorio-nfe-${ano}-${mes2}.xml"`,
          )
          .send(xml);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao gerar relatorio mensal";
        return reply
          .status(message.includes("Emitente selecionado") ? 404 : 500)
          .send({ error: message });
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
          select: {
            danfePdfPath: true,
            xmlAutorizadoPath: true,
            numero: true,
            serie: true,
            modelo: true,
          },
        });
        if (!row) {
          return reply.status(404).send({ error: "NF-e nao encontrada" });
        }

        // O gate `danfePdfPath` é PRESERVADO: quem decide se a nota tem DANFE
        // continua sendo o banco, exatamente como antes. Nota sem DANFE gravado
        // segue devolvendo 404 — o re-render melhora o layout do documento que
        // já sairia, não muda a resposta do endpoint.
        if (!row.danfePdfPath) {
          return reply.status(404).send({ error: "DANFE nao disponivel" });
        }

        // Re-render a partir do XML autorizado (fonte canônica), para que notas
        // emitidas ANTES do redesenho também saiam no layout novo. É estritamente
        // best-effort: qualquer falha cai no PDF gravado em disco, que é o
        // comportamento de sempre. Nunca transforma um download que funciona
        // hoje num erro.
        const fresh = await tryRerenderDanfe(storage, row.xmlAutorizadoPath);

        const content = fresh ?? (await storage.readFile(row.danfePdfPath));
        if (!content) {
          return reply.status(404).send({ error: "Arquivo DANFE nao encontrado" });
        }
        const prefixo = String(row.modelo) === "65" ? "cupom" : "danfe";
        // `storage.readFile` já devolve Buffer; só o re-render devolve
        // Uint8Array. Copiar o que já é Buffer duplicaria o PDF inteiro em
        // memória a cada download servido do disco — o caminho mais comum.
        const corpo = Buffer.isBuffer(content)
          ? content
          : Buffer.from(content as Uint8Array);
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="${prefixo}-${row.serie}-${row.numero}.pdf"`,
          )
          .send(corpo);
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
        // Multi-CNPJ: emitente da faixa (opcional; ausente = padrão). Tipo
        // inválido → 400 — NUNCA degradar em silêncio para o padrão numa
        // operação irreversível na SEFAZ (inutilizaria a faixa do CNPJ errado).
        const inutCompanyId = parseCompanyIdParam(body.companyFiscalConfigId);
        if (inutCompanyId === undefined) {
          return reply.status(400).send({ error: "Emitente inválido" });
        }
        const result = await nfeInutilizacao.inutilizar(userId, {
          serie: Number(body.serie),
          numeroInicial: Number(body.numeroInicial),
          numeroFinal: Number(body.numeroFinal),
          justificativa: body.justificativa ?? "",
          companyFiscalConfigId: inutCompanyId,
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
            : message.includes("Emitente selecionado")
              ? 404
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
        // Mesmo re-render best-effort do download, para o anexo do e-mail não
        // sair num layout diferente do que o cliente baixa pela tela.
        //
        // O gate `nfe.danfePdfPath` é DELIBERADAMENTE preservado: ele decide se
        // existe anexo, e essa decisão não pode mudar. Nota cujo DANFE falhou na
        // emissão continua enviando e-mail SEM PDF, exatamente como antes —
        // acrescentar um anexo onde antes não havia mudaria o conteúdo de uma
        // mensagem que vai para o cliente final. O que o re-render altera é só o
        // LAYOUT do anexo que já sairia.
        if (nfe.danfePdfPath) {
          const danfeFresh = await tryRerenderDanfe(storage, nfe.xmlAutorizadoPath);
          const pdfContent = danfeFresh ?? (await storage.readFile(nfe.danfePdfPath));
          if (pdfContent) {
            attachments.push({
              filename: `danfe-${nfe.serie}-${nfe.numero}.pdf`,
              content: Buffer.isBuffer(pdfContent)
                ? pdfContent
                : Buffer.from(pdfContent as Uint8Array),
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
