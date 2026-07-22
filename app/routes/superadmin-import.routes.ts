import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireSuperadmin } from "../middlewares/require-superadmin.middleware";
import type {
  ImportEntity,
  ImportFile,
  ImportSystem,
} from "../usecases/import/import.types";
import {
  ImportConflictError,
  ImportValidationError,
} from "../usecases/import/import.types";
import { ImportPreviewUseCase } from "../usecases/import/import-preview.usecase";
import { ImportApplyUseCase } from "../usecases/import/import-apply.usecase";
import { SystemLogImportJobStore } from "../usecases/import/import-job.store";
import { availableEntities } from "../usecases/import/import-runners";

const jobStore = new SystemLogImportJobStore();
const previewUseCase = new ImportPreviewUseCase();
const applyUseCase = new ImportApplyUseCase(jobStore);

/**
 * Aceitos = exatamente o que o registry de runners expõe (é a MESMA lista que
 * o GET /import/entities entrega ao seletor do modal).
 *
 * Antes eram dois `Set` escritos à mão aqui. Registrar um runner novo passava
 * a anunciar a opção na UI mas a rota continuava recusando com 400 "Entidade
 * inválida" — foi o que aconteceu com VAAPT/FOTOS. Derivar mata a classe do
 * bug: a rota não tem mais como divergir do que o motor oferece.
 */
const VALID_SYSTEMS = new Set<ImportSystem>(
  availableEntities().map((a) => a.system),
);
const VALID_ENTITIES = new Set<ImportEntity>(
  availableEntities().map((a) => a.entity),
);

interface MultipartPayload {
  fields: Record<string, string>;
  files: ImportFile[];
}

/**
 * O @fastify/multipart põe o código do erro em `err.code` (a mensagem é só
 * "request file too large") — casar por message nunca acerta (mesmo bug já
 * corrigido em image.routes.ts). Testa code E message por robustez.
 */
function isFileTooLargeError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  return /(FST_FILES_LIMIT|FST_REQ_FILE_TOO_LARGE)/.test(`${code} ${msg}`);
}

/**
 * Lê o multipart inteiro em memória (limite global de 20MB por arquivo,
 * registrado em api.ts). O erro de tamanho pode estourar tanto no
 * toBuffer() quanto no próprio iterador parts() — o catch cobre os dois.
 */
async function readMultipart(request: FastifyRequest): Promise<MultipartPayload> {
  const fields: Record<string, string> = {};
  const files: ImportFile[] = [];
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        files.push({
          fieldname: part.fieldname,
          filename: part.filename ?? part.fieldname,
          buffer: await part.toBuffer(),
        });
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }
  } catch (e: unknown) {
    if (isFileTooLargeError(e)) {
      throw new ImportValidationError(
        "Arquivo muito grande — o tamanho máximo permitido é 20MB.",
      );
    }
    throw e;
  }
  return { fields, files };
}

function parseCommonFields(fields: Record<string, string>): {
  targetUserId: string;
  system: ImportSystem;
  entity: ImportEntity;
} {
  const targetUserId = (fields.targetUserId ?? "").trim();
  const system = (fields.system ?? "").trim().toUpperCase() as ImportSystem;
  const entity = (fields.entity ?? "").trim().toUpperCase() as ImportEntity;
  if (!targetUserId) {
    throw new ImportValidationError("Informe o administrador-alvo (targetUserId).");
  }
  if (!VALID_SYSTEMS.has(system)) {
    throw new ImportValidationError(
      "Sistema inválido. Use VAAPT, WEBDESMONTE, IBR ou DEXO.",
    );
  }
  if (!VALID_ENTITIES.has(entity)) {
    throw new ImportValidationError("Entidade inválida.");
  }
  return { targetUserId, system, entity };
}

function sendImportError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof ImportValidationError ||
    error instanceof ImportConflictError
  ) {
    return reply.status(error.statusCode).send({ message: error.message });
  }
  console.error("[superadmin-import]", error);
  return reply.status(500).send({
    message:
      error instanceof Error ? error.message : "Erro na importação de dados",
  });
}

const requireMultipart = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  if (!request.isMultipart()) {
    return reply.status(400).send({
      message:
        "Esperado multipart/form-data com targetUserId, system, entity e o(s) arquivo(s).",
    });
  }
};

/**
 * Rotas de importação de dados legados (painel Superadmin). Todas sob
 * [authMiddleware, requireSuperadmin]; todos os dados são criados no tenant
 * do `targetUserId` (admin escolhido no modal). Aditivo — nenhuma rota
 * existente é alterada.
 */
export const superadminImportRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /superadmin/import/entities — combinações sistema×entidade já
   * habilitadas no motor (a UI monta os selects a partir daqui, então novas
   * entidades aparecem sem mudança no front).
   */
  fastify.get(
    "/import/entities",
    { preHandler: [authMiddleware, requireSuperadmin] },
    async (_request, reply) => {
      return reply.status(200).send({ entities: availableEntities() });
    },
  );

  /**
   * POST /superadmin/import/preview — dry-run OBRIGATÓRIO: parseia, mapeia e
   * devolve contadores/amostra/erros + previewHash. NÃO escreve nada.
   */
  fastify.post(
    "/import/preview",
    { preHandler: [authMiddleware, requireSuperadmin, requireMultipart] },
    async (request, reply) => {
      try {
        const { fields, files } = await readMultipart(request);
        const common = parseCommonFields(fields);
        const result = await previewUseCase.preview({ ...common, files });
        return reply.status(200).send(result);
      } catch (error) {
        return sendImportError(reply, error);
      }
    },
  );

  /**
   * POST /superadmin/import/apply — recebe os MESMOS arquivos + o
   * previewHash aprovado; hash divergente ⇒ 409. Executa como job assíncrono
   * (202 + jobId) — importações grandes (ex.: products.csv com ~13,7k linhas)
   * nunca rodam síncronas.
   */
  fastify.post(
    "/import/apply",
    { preHandler: [authMiddleware, requireSuperadmin, requireMultipart] },
    async (request, reply) => {
      try {
        const { fields, files } = await readMultipart(request);
        const common = parseCommonFields(fields);
        const previewHash = (fields.previewHash ?? "").trim();
        const actorUserId = (request as { user?: { id?: string } }).user?.id;
        const { jobId } = await applyUseCase.apply({
          ...common,
          files,
          previewHash,
          actorUserId,
        });
        return reply.status(202).send({ jobId });
      } catch (error) {
        return sendImportError(reply, error);
      }
    },
  );

  /**
   * GET /superadmin/import/status/:jobId — progresso + relatório final.
   * "INTERROMPIDO" = job RUNNING sem heartbeat há 15min (processo reiniciou);
   * re-executar é seguro (importação idempotente).
   */
  fastify.get<{ Params: { jobId: string } }>(
    "/import/status/:jobId",
    { preHandler: [authMiddleware, requireSuperadmin] },
    async (request, reply) => {
      try {
        const status = await jobStore.get(request.params.jobId);
        if (!status) {
          return reply
            .status(404)
            .send({ message: "Importação não encontrada." });
        }
        return reply.status(200).send(status);
      } catch (error) {
        return sendImportError(reply, error);
      }
    },
  );
};
