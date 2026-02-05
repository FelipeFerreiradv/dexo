import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { writeFile, mkdir } from "fs/promises";
import { join, extname } from "path";
import { randomUUID } from "crypto";

export async function uploadRoutes(app: FastifyInstance) {
  /**
   * POST /upload/image
   * Faz upload de uma imagem e retorna a URL
   */
  app.post(
    "/image",
    {
      // Configurar para aceitar multipart/form-data
      preHandler: async (request, reply) => {
        // Verificar se é multipart
        if (!request.isMultipart()) {
          return reply.status(400).send({
            error: "Tipo de conteúdo inválido",
            message: "Esperado multipart/form-data",
          });
        }
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = await request.file();

        if (!data) {
          return reply.status(400).send({
            error: "Arquivo não encontrado",
            message: "Nenhum arquivo foi enviado",
          });
        }

        // Validar tipo do arquivo
        const allowedTypes = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/webp",
        ];
        if (!allowedTypes.includes(data.mimetype)) {
          return reply.status(400).send({
            error: "Tipo de arquivo inválido",
            message: "Apenas imagens JPEG, PNG e WebP são permitidas",
          });
        }

        // Validar tamanho (máximo 5MB)
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (data.file.truncated || data.file.bytesRead > maxSize) {
          return reply.status(400).send({
            error: "Arquivo muito grande",
            message: "O tamanho máximo permitido é 5MB",
          });
        }

        // Gerar nome único para o arquivo
        const fileExtension = extname(data.filename) || ".jpg";
        const fileName = `${randomUUID()}${fileExtension}`;

        // Caminho completo para salvar
        const uploadDir = join(process.cwd(), "public", "uploads");
        const filePath = join(uploadDir, fileName);

        // Garantir que o diretório existe
        await mkdir(uploadDir, { recursive: true });

        // Ler o buffer do arquivo
        const buffer = await data.toBuffer();

        // Salvar arquivo
        await writeFile(filePath, buffer);

        // Retornar URL da imagem
        const baseUrl = "http://localhost:3333";
        const imageUrl = `${baseUrl}/uploads/${fileName}`;

        return reply.status(200).send({
          success: true,
          message: "Imagem enviada com sucesso",
          imageUrl,
          fileName,
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
