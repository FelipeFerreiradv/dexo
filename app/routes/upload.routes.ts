import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { access, writeFile, mkdir, unlink } from "fs/promises";
import { join, extname } from "path";
import { randomUUID } from "crypto";
import {
  processUploadedImage,
  type ProcessedImageFormat,
} from "../marketplaces/services/image-resize.service";
import { readHandlerBudgetMs } from "../marketplaces/services/rembg-budget";
import { recordImageOutcome } from "../marketplaces/services/rembg-telemetry";
import { isAsyncBgEnabled } from "../marketplaces/services/image-bg-worker.service";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — alinhado com a UI

const FORMAT_EXTENSION: Record<ProcessedImageFormat, string> = {
  webp: ".webp",
  png: ".png",
  jpeg: ".jpg",
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function safeExt(filename: string): string {
  const ext = extname(filename || "").toLowerCase();
  if (ext === ".jpeg" || ext === ".jpg") return ".jpg";
  if (ext === ".png") return ".png";
  if (ext === ".webp") return ".webp";
  return ".bin"; // não confiável, mas só usado no arquivo .orig
}

export async function uploadRoutes(app: FastifyInstance) {
  /**
   * POST /upload/image
   *
   * Multipart:
   *  - file: imagem (jpg/png/webp), até 20 MB
   *  - removeBackground (opcional): "true" | "false" (default "true")
   *  - addShadow (opcional): "true" | "false" (default "false"). Adiciona
   *    sombra de contato; exige recorte — ignorado se removeBackground=false.
   *
   * Pipeline:
   *  1. Lê o arquivo e os campos do multipart (em qualquer ordem).
   *  2. Salva o ORIGINAL como `<uuid>.orig.<ext>` no storage local.
   *  3. Aplica `processUploadedImage`: strip EXIF + autoOrient + resize
   *     1000–1600px + (opcional) remoção de fundo via sidecar + encode
   *     final (WebP q88 quando sem remoção, PNG transparente otimizado
   *     quando removeu fundo).
   *  4. Salva a versão processada como `<uuid>.<format>`.
   *  5. Devolve as duas URLs + flag indicando se o fundo foi removido,
   *     mais um `warning` opcional quando o sidecar caiu e degradamos.
   *
   * Compatibilidade: `imageUrl` continua sendo o campo principal. Clientes
   * antigos (que não conhecem `originalUrl`/`removedBackground`/`warning`)
   * continuam funcionando — recebem o WebP otimizado por default.
   */
  app.post(
    "/image",
    {
      // SEGURANÇA: exige autenticação (a ponte de auth do front injeta o Bearer
      // nesta chamada também). Antes era anônima — abuso de disco/DoS.
      preHandler: [
        authMiddleware,
        async (request, reply) => {
          if (!request.isMultipart()) {
            return reply.status(400).send({
              error: "Tipo de conteúdo inválido",
              message: "Esperado multipart/form-data",
            });
          }
        },
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Carimba o início do handler: o nginx começa a contar antes disso, então
      // quanto mais cedo, mais conservador o orçamento. Ver `rembg-budget`.
      const startedAt = Date.now();
      const deadlineAt = startedAt + readHandlerBudgetMs();
      try {
        let buffer: Buffer | null = null;
        let mimetype = "";
        let originalFilename = "";
        let removeBackground = true; // default ON
        let addShadow = false; // default OFF server-side (protege clientes antigos)
        let asyncBg = false; // opt-in do CLIENTE (duplo opt-in com UPLOAD_ASYNC_REMBG)

        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file") {
              // descarta outros arquivos para liberar o stream
              await part.toBuffer().catch(() => undefined);
              continue;
            }
            mimetype = part.mimetype;
            originalFilename = part.filename ?? "";
            try {
              buffer = await part.toBuffer();
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              if (/(FST_FILES_LIMIT|FST_REQ_FILE_TOO_LARGE)/.test(msg)) {
                return reply.status(400).send({
                  error: "Arquivo muito grande",
                  message: "O tamanho máximo permitido é 20MB",
                });
              }
              throw e;
            }
          } else if (part.type === "field") {
            if (part.fieldname === "removeBackground") {
              removeBackground = parseBoolean(
                typeof part.value === "string"
                  ? part.value
                  : String(part.value),
                true,
              );
            } else if (part.fieldname === "addShadow") {
              addShadow = parseBoolean(
                typeof part.value === "string"
                  ? part.value
                  : String(part.value),
                false,
              );
            } else if (part.fieldname === "asyncBg") {
              asyncBg = parseBoolean(
                typeof part.value === "string"
                  ? part.value
                  : String(part.value),
                false,
              );
            }
          }
        }

        if (!buffer) {
          return reply.status(400).send({
            error: "Arquivo não encontrado",
            message: "Nenhum arquivo foi enviado no campo `file`",
          });
        }

        if (!ALLOWED_MIME.has(mimetype)) {
          return reply.status(400).send({
            error: "Tipo de arquivo inválido",
            message: "Apenas imagens JPEG, PNG e WebP são permitidas",
          });
        }

        if (buffer.byteLength > MAX_BYTES) {
          return reply.status(400).send({
            error: "Arquivo muito grande",
            message: "O tamanho máximo permitido é 20MB",
          });
        }

        const uuid = randomUUID();
        const originalExt = safeExt(originalFilename);
        const uploadDir = join(process.cwd(), "public", "uploads");
        await mkdir(uploadDir, { recursive: true });

        // 1) Salva o original SEMPRE (independente do toggle) — preserva
        // a imagem-fonte para reprocessar caso algo dê errado depois.
        const originalFileName = `${uuid}.orig${originalExt}`;
        const originalPath = join(uploadDir, originalFileName);
        await writeFile(originalPath, buffer);

        // CAMINHO ASSÍNCRONO (PR 4) — duplo opt-in: UPLOAD_ASYNC_REMBG no env
        // E o campo asyncBg do cliente atualizado. Responde JÁ com a WebP
        // otimizada (~1s, sem sidecar) + jobId; o ImageBgWorkerService faz o
        // recorte sem orçamento de request e troca as referências ao concluir.
        // Clientes antigos (sem asyncBg) e o config-modal seguem no síncrono
        // byte-a-byte. NÃO registra telemetria aqui: o desfecho REAL do
        // recorte é registrado pelo worker (senão cada upload async contaria
        // como fallback e envenenaria a taxa).
        if (removeBackground && asyncBg && isAsyncBgEnabled()) {
          const webpResult = await processUploadedImage(buffer, {
            removeBackground: false,
          });
          const processedFileName = `${uuid}${FORMAT_EXTENSION[webpResult.format]}`;
          const processedPath = join(uploadDir, processedFileName);
          await writeFile(processedPath, webpResult.processed);

          // dataOwnerId, NÃO user.id: para COLABORADOR, toda linha de dado do
          // tenant (Product/Scrap) usa o dono (parentUserId) — com user.id o
          // swap do worker seria um no-op silencioso e a foto ficaria WebP.
          const tenantId =
            (request as any).user?.dataOwnerId ??
            (request as any).user?.id ??
            null;
          let job: { id: string };
          try {
            job = await (prisma as any).imageBgJob.create({
              data: {
                uploadUuid: uuid,
                origFileName: originalFileName,
                webpFileName: processedFileName,
                addShadow,
                userId: tenantId,
              },
            });
          } catch (createErr) {
            // Sem job não há quem processe a WebP provisória: remove-a para
            // não virar lixo permanente (o GC só varre .orig) e deixa o catch
            // global responder 500 — o cliente re-tenta com uuid novo.
            await unlink(processedPath).catch(() => undefined);
            throw createErr;
          }

          const baseUrl = process.env.APP_BACKEND_URL || "http://localhost:3333";
          return reply.status(200).send({
            success: true,
            message: "Imagem enviada com sucesso",
            imageUrl: `${baseUrl}/uploads/${processedFileName}`,
            originalUrl: `${baseUrl}/uploads/${originalFileName}`,
            fileName: processedFileName,
            removedBackground: false,
            shadowApplied: false,
            format: webpResult.format,
            width: webpResult.width,
            height: webpResult.height,
            // Aditivo: presença de bgJob = "recorte em processamento" (o
            // front troca a imagem quando o job concluir). SEM warning — não
            // é degradação, é o caminho novo.
            bgJob: { jobId: job.id, status: "PENDING" },
          });
        }

        // 2) Processa (resize + opcional remoção de fundo + sombra + encode).
        // Sombra exige recorte: o serviço só a aplica no caminho de remoção,
        // então com removeBackground=false o addShadow é naturalmente ignorado.
        const result = await processUploadedImage(buffer, {
          removeBackground,
          addShadow,
          // Tráfego do modal: lane prioritária no gate do sidecar, e deadline
          // para que a degradação graceful rode ANTES do 504 do nginx.
          lane: "internal",
          deadlineAt,
        });

        // Telemetria (aditiva, nunca no caminho da resposta): a taxa de
        // fallback é sobre quem PEDIU recorte — só registra nesse caso.
        if (removeBackground) {
          recordImageOutcome({
            source: "upload",
            lane: "internal",
            result,
            durationMs: Date.now() - startedAt,
            userId: (request as any).user?.id,
          });
        }

        const processedFileName = `${uuid}${FORMAT_EXTENSION[result.format]}`;
        const processedPath = join(uploadDir, processedFileName);
        await writeFile(processedPath, result.processed);

        const baseUrl = process.env.APP_BACKEND_URL || "http://localhost:3333";
        const imageUrl = `${baseUrl}/uploads/${processedFileName}`;
        const originalUrl = `${baseUrl}/uploads/${originalFileName}`;

        return reply.status(200).send({
          success: true,
          message: "Imagem enviada com sucesso",
          imageUrl,
          originalUrl,
          fileName: processedFileName,
          removedBackground: result.removedBackground,
          shadowApplied: result.shadowApplied ?? false,
          format: result.format,
          width: result.width,
          height: result.height,
          ...(result.warning ? { warning: result.warning } : {}),
        });
      } catch (error) {
        console.error("[Upload] Erro ao fazer upload:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /upload/image/jobs?ids=a,b,c — polling do recorte assíncrono.
   * Escopado pelo DONO do upload (o polling acontece na mesma sessão que fez
   * o upload). Batch de até 50 ids; ids de outros usuários simplesmente não
   * voltam (sem vazamento de existência).
   */
  app.get(
    "/image/jobs",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Escopo por TENANT (dataOwnerId): jobs de colaborador pertencem ao
      // dono dos dados — o mesmo escopo de Product/Scrap.
      const user = (request as any).user;
      const userId = (user?.dataOwnerId ?? user?.id) as string | undefined;
      if (!userId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      // `?ids=a&ids=b` chega como ARRAY no fastify — normaliza antes do split.
      const rawParam = (request.query as { ids?: string | string[] }).ids ?? "";
      const idsRaw = Array.isArray(rawParam) ? rawParam.join(",") : rawParam;
      const ids = idsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 50);
      if (ids.length === 0) {
        return reply.status(200).send({ jobs: [] });
      }

      const rows = await (prisma as any).imageBgJob.findMany({
        where: { id: { in: ids }, userId },
        select: {
          id: true,
          status: true,
          attempts: true,
          resultFileName: true,
          webpFileName: true,
          lastError: true,
        },
      });

      const baseUrl = process.env.APP_BACKEND_URL || "http://localhost:3333";
      return reply.status(200).send({
        jobs: rows.map((j: any) => ({
          id: j.id,
          status: j.status,
          attempts: j.attempts,
          webpUrl: `${baseUrl}/uploads/${j.webpFileName}`,
          ...(j.resultFileName
            ? { resultUrl: `${baseUrl}/uploads/${j.resultFileName}` }
            : {}),
          ...(j.status === "FAILED" && j.lastError
            ? { error: j.lastError }
            : {}),
        })),
      });
    },
  );

  /** POST /upload/image/jobs/:id/retry — re-enfileira um job FAILED (dono). */
  app.post(
    "/image/jobs/:id/retry",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      const userId = (user?.dataOwnerId ?? user?.id) as string | undefined;
      if (!userId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const { id } = request.params as { id: string };
      const updated = await (prisma as any).imageBgJob.updateMany({
        where: { id, userId, status: "FAILED" },
        data: {
          status: "PENDING",
          attempts: 0,
          nextRunAt: new Date(),
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (updated.count === 0) {
        return reply.status(404).send({
          error: "Job não encontrado",
          message: "Job inexistente, de outro usuário ou não está FAILED",
        });
      }
      return reply.status(200).send({ success: true, status: "PENDING" });
    },
  );

  /**
   * POST /upload/image/edited — SAVE do Editor de Imagem (PR 6).
   *
   * Multipart: file (PNG/JPEG exportado do canvas, até 20MB) + campos
   * recipe (JSON EditRecipeV1), sourceFileName e cutoutFileName (opcional).
   * NÃO roda processUploadedImage: o export do canvas já está na resolução
   * e formato finais — reprocessar só degradaria. Cada save gera um uuid
   * NOVO (versionamento — nunca sobrescreve arquivo existente) e grava a
   * receita em ProductImageEdit atomicamente (create falhou => arquivo
   * removido, 500, cliente re-tenta).
   */
  app.post(
    "/image/edited",
    {
      preHandler: [
        authMiddleware,
        async (request, reply) => {
          if (!request.isMultipart()) {
            return reply.status(400).send({
              error: "Tipo de conteúdo inválido",
              message: "Esperado multipart/form-data",
            });
          }
        },
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as any).user;
        const tenantId = (user?.dataOwnerId ?? user?.id ?? null) as
          | string
          | null;

        let buffer: Buffer | null = null;
        let mimetype = "";
        let recipeRaw = "";
        let sourceFileName = "";
        let cutoutFileName = "";

        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file") {
              await part.toBuffer().catch(() => undefined);
              continue;
            }
            mimetype = part.mimetype;
            try {
              buffer = await part.toBuffer();
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              if (/(FST_FILES_LIMIT|FST_REQ_FILE_TOO_LARGE)/.test(msg)) {
                return reply.status(400).send({
                  error: "Arquivo muito grande",
                  message: "O tamanho máximo permitido é 20MB",
                });
              }
              throw e;
            }
          } else if (part.type === "field") {
            const value =
              typeof part.value === "string" ? part.value : String(part.value);
            if (part.fieldname === "recipe") recipeRaw = value;
            else if (part.fieldname === "sourceFileName") sourceFileName = value;
            else if (part.fieldname === "cutoutFileName") cutoutFileName = value;
          }
        }

        if (!buffer) {
          return reply.status(400).send({
            error: "Arquivo não encontrado",
            message: "Nenhum arquivo foi enviado no campo `file`",
          });
        }
        // O export do editor é sempre PNG (transparência) ou JPEG (opaco).
        const EDITED_EXT: Record<string, string> = {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/jpg": ".jpg",
        };
        const ext = EDITED_EXT[mimetype];
        if (!ext) {
          return reply.status(400).send({
            error: "Tipo de arquivo inválido",
            message: "O export do editor deve ser PNG ou JPEG",
          });
        }
        if (buffer.byteLength > MAX_BYTES) {
          return reply.status(400).send({
            error: "Arquivo muito grande",
            message: "O tamanho máximo permitido é 20MB",
          });
        }
        // Nomes de arquivo são BASENAMES de public/uploads — qualquer coisa
        // com separador/".." é tentativa de traversal, rejeita seco.
        if (
          (sourceFileName && !isSafeUploadBasename(sourceFileName)) ||
          (cutoutFileName && !isSafeUploadBasename(cutoutFileName))
        ) {
          return reply.status(400).send({
            error: "Nome de arquivo inválido",
            message: "sourceFileName/cutoutFileName inválido",
          });
        }
        if (!sourceFileName) {
          return reply.status(400).send({
            error: "Campo obrigatório ausente",
            message: "sourceFileName é obrigatório",
          });
        }
        if (!recipeRaw || recipeRaw.length > 100_000) {
          return reply.status(400).send({
            error: "Receita inválida",
            message: "recipe ausente ou grande demais (máx. 100KB)",
          });
        }
        let recipe: unknown;
        try {
          recipe = JSON.parse(recipeRaw);
        } catch {
          return reply.status(400).send({
            error: "Receita inválida",
            message: "recipe não é JSON válido",
          });
        }
        if (
          !recipe ||
          typeof recipe !== "object" ||
          (recipe as { version?: unknown }).version !== 1
        ) {
          return reply.status(400).send({
            error: "Receita inválida",
            message: "recipe.version deve ser 1 (EditRecipeV1)",
          });
        }

        const uuid = randomUUID();
        const fileName = `${uuid}${ext}`;
        const uploadDir = join(process.cwd(), "public", "uploads");
        await mkdir(uploadDir, { recursive: true });
        const filePath = join(uploadDir, fileName);
        await writeFile(filePath, buffer);

        try {
          await (prisma as any).productImageEdit.create({
            data: {
              fileName,
              sourceFileName,
              cutoutFileName: cutoutFileName || null,
              recipe,
              userId: tenantId,
            },
          });
        } catch (createErr) {
          // Sem a receita o arquivo é órfão sem história — remove e falha.
          await unlink(filePath).catch(() => undefined);
          throw createErr;
        }

        const baseUrl = process.env.APP_BACKEND_URL || "http://localhost:3333";
        return reply.status(200).send({
          success: true,
          message: "Imagem editada salva com sucesso",
          imageUrl: `${baseUrl}/uploads/${fileName}`,
          fileName,
        });
      } catch (error) {
        console.error("[Upload] Erro ao salvar imagem editada:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /upload/image/meta?fileName= — contexto para REABRIR uma imagem no
   * editor (PR 6): se o arquivo veio de um save do editor, devolve a receita
   * (escopada pelo tenant); em qualquer caso tenta resolver o ORIGINAL
   * `<uuid>.orig.<ext>` no disco para reprocessar/editar do zero.
   */
  app.get(
    "/image/meta",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      const userId = (user?.dataOwnerId ?? user?.id) as string | undefined;
      const { fileName } = request.query as { fileName?: string };
      if (!fileName || !isSafeUploadBasename(fileName)) {
        return reply.status(400).send({
          error: "Parâmetro inválido",
          message: "fileName ausente ou inválido",
        });
      }

      const baseUrl = process.env.APP_BACKEND_URL || "http://localhost:3333";
      const uploadDir = join(process.cwd(), "public", "uploads");

      // Receita do editor (se este arquivo é um save anterior) — escopo do
      // tenant: receita de outro usuário simplesmente não volta.
      let edit: {
        recipe: unknown;
        sourceFileName: string;
        cutoutFileName: string | null;
      } | null = null;
      try {
        const row = await (prisma as any).productImageEdit.findFirst({
          where: { fileName, ...(userId ? { userId } : {}) },
          select: { recipe: true, sourceFileName: true, cutoutFileName: true },
        });
        if (row) edit = row;
      } catch {
        // tabela ausente (DDL ainda não aplicado) não pode derrubar a rota
      }

      // Original no disco: o uuid é o prefixo até o primeiro ponto.
      const uuid = fileName.split(".")[0] ?? "";
      let originalFileName: string | null = null;
      if (uuid) {
        for (const ext of [".jpg", ".png", ".webp", ".bin"]) {
          const candidate = `${uuid}.orig${ext}`;
          try {
            await access(join(uploadDir, candidate));
            originalFileName = candidate;
            break;
          } catch {
            // tenta a próxima extensão
          }
        }
      }

      return reply.status(200).send({
        fileName,
        ...(originalFileName
          ? {
              originalFileName,
              originalUrl: `${baseUrl}/uploads/${originalFileName}`,
            }
          : {}),
        ...(edit
          ? {
              edit: {
                recipe: edit.recipe,
                sourceFileName: edit.sourceFileName,
                sourceUrl: `${baseUrl}/uploads/${edit.sourceFileName}`,
                ...(edit.cutoutFileName
                  ? {
                      cutoutFileName: edit.cutoutFileName,
                      cutoutUrl: `${baseUrl}/uploads/${edit.cutoutFileName}`,
                    }
                  : {}),
              },
            }
          : {}),
      });
    },
  );
}

/** Basename seguro de public/uploads: sem separadores, sem "..", só o shape
 *  que o próprio upload gera (uuid + sufixos com ponto/hífen). */
function isSafeUploadBasename(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) && !name.includes("..")
  );
}
