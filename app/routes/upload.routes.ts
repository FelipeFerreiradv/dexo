import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { writeFile, mkdir } from "fs/promises";
import { join, extname } from "path";
import { randomUUID } from "crypto";
import {
  processUploadedImage,
  type ProcessedImageFormat,
} from "../marketplaces/services/image-resize.service";
import { readHandlerBudgetMs } from "../marketplaces/services/rembg-budget";
import { recordImageOutcome } from "../marketplaces/services/rembg-telemetry";
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
}
