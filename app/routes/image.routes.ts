import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { processUploadedImage } from "../marketplaces/services/image-resize.service";
import { authMiddleware } from "../middlewares/auth.middleware";

// Mesmas validações do POST /upload/image, REPLICADAS aqui de propósito.
// Não importamos de upload.routes.ts para manter aquele arquivo (e o fluxo do
// modal de criação de produto) byte-a-byte inalterado. Não há util compartilhado
// no repo — a convenção é inline por rota (upload/product/fiscal).
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — alinhado com /upload/image

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

// Headers HTTP são serializados em latin1 pelo Node. O warning do serviço tem
// acentos (ç, ã, í) — sem esta dobra ASCII, um consumidor UTF-8 leria mojibake.
// Só afeta o VALOR do header X-Warning; a mensagem no serviço fica intocada.
function asciiFold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export async function imageRoutes(app: FastifyInstance) {
  /**
   * POST /v1/images/process
   *
   * Endpoint PÚBLICO e stateless de processamento de imagem (remoção de fundo +
   * sombra), reutilizando o mesmo pipeline (`processUploadedImage`) e o mesmo
   * sidecar `rembg` do modal de criação de produto. Pensado para consumo por
   * sistemas externos (ex.: Desmont Hub).
   *
   * Multipart:
   *  - file: imagem (jpeg/jpg/png/webp), até 5 MB
   *  - removeBackground (opcional): "true" | "false" (default "true")
   *  - addShadow (opcional): "true" | "false" (default "false"). Sombra de
   *    contato; exige recorte — ignorado quando removeBackground=false.
   *
   * Resposta (200): os BYTES da imagem processada no corpo, com Content-Type
   * `image/png` (recorte) ou `image/webp` (fallback/otimizado). Metadados vão
   * em headers: X-Removed-Background, X-Shadow-Applied, X-Image-Format,
   * X-Image-Width, X-Image-Height e X-Warning (só em degradação graceful).
   *
   * STATELESS: processa em memória e NÃO escreve nada em disco (não persiste
   * imagens de terceiros no servidor). Falha do sidecar NÃO é erro: degrada
   * graceful (200 + imagem otimizada + X-Removed-Background:false + X-Warning).
   */
  app.post(
    "/process",
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
        let buffer: Buffer | null = null;
        let mimetype = "";
        let removeBackground = true; // default ON
        let addShadow = false; // default OFF

        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file") {
              // descarta outros arquivos para liberar o stream
              await part.toBuffer().catch(() => undefined);
              continue;
            }
            mimetype = part.mimetype;
            try {
              buffer = await part.toBuffer();
            } catch (e: unknown) {
              // Oversize (>5 MB) estoura o limite global do @fastify/multipart
              // durante o toBuffer(). O código FST_REQ_FILE_TOO_LARGE fica em
              // `e.code` (NÃO em `e.message`), então casamos pelo code — assim
              // devolvemos 400 conforme o contrato (o padrão copiado do
              // upload.routes casava por message e nunca acertava aqui).
              const code = (e as { code?: string } | null)?.code;
              const asString = e instanceof Error ? e.stack ?? e.message : String(e);
              if (
                code === "FST_REQ_FILE_TOO_LARGE" ||
                code === "FST_FILES_LIMIT" ||
                /FST_REQ_FILE_TOO_LARGE|FST_FILES_LIMIT/.test(asString)
              ) {
                return reply.status(400).send({
                  error: "Arquivo muito grande",
                  message: "O tamanho máximo permitido é 5MB",
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
            message: "O tamanho máximo permitido é 5MB",
          });
        }

        // Reutiliza o pipeline existente SEM modificá-lo. Sombra exige recorte:
        // o serviço só a aplica no caminho de remoção; com removeBackground=false
        // o addShadow é naturalmente ignorado.
        const result = await processUploadedImage(buffer, {
          removeBackground,
          addShadow,
        });

        // Content-Type DEVE ser setado ANTES do send(): é o que faz o
        // @fastify/compress pular a compressão de imagens já comprimidas
        // (mime-db marca image/png e image/webp como não-compressíveis).
        const contentType =
          result.format === "png" ? "image/png" : "image/webp";
        reply.type(contentType);
        reply.header("X-Removed-Background", String(result.removedBackground));
        reply.header("X-Shadow-Applied", String(result.shadowApplied ?? false));
        reply.header("X-Image-Format", result.format);
        if (typeof result.width === "number") {
          reply.header("X-Image-Width", String(result.width));
        }
        if (typeof result.height === "number") {
          reply.header("X-Image-Height", String(result.height));
        }
        if (result.warning) {
          reply.header("X-Warning", asciiFold(result.warning));
        }

        // Corpo = bytes da imagem processada. Fastify calcula o Content-Length
        // do Buffer automaticamente; nada é escrito em disco.
        return reply.send(result.processed);
      } catch (error) {
        console.error("[ImageProcess] Erro ao processar imagem:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );
}
