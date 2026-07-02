import * as fs from "fs";
import * as path from "path";

/**
 * Storage da mídia RECEBIDA pelo WhatsApp (fotos/áudios/documentos de cliente).
 * Espelha o ShippingLabelStorageService, em base própria.
 *
 * PRIVACIDADE: mídia de cliente NUNCA vai para public/uploads (que é servido
 * estático sem auth). Os arquivos ficam fora de `public/` e são servidos
 * exclusivamente pela rota autenticada GET /whatsapp/media/:messageId.
 *
 * Base: WHATSAPP_STORAGE_PATH || {cwd}/.whatsapp-storage
 * Estrutura: {base}/{userId}/media/{conversationId}/{messageId}.{ext}
 */

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

export class WhatsAppMediaStorageService {
  private basePath: string;

  constructor() {
    this.basePath =
      process.env.WHATSAPP_STORAGE_PATH ||
      path.join(process.cwd(), ".whatsapp-storage");
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  static extensionForMime(mime: string | null | undefined): string {
    if (!mime) return "bin";
    // mime pode vir com parâmetros (ex.: "audio/ogg; codecs=opus").
    const clean = mime.split(";")[0].trim().toLowerCase();
    return EXT_BY_MIME[clean] ?? "bin";
  }

  /**
   * Salva a mídia de uma mensagem. Ids são cuids gerados por nós — sem input
   * do cliente no caminho (sem path traversal). Retorna o caminho absoluto,
   * persistido em WhatsAppMessage.mediaPath.
   */
  async saveMedia(
    userId: string,
    conversationId: string,
    messageId: string,
    mimeType: string | null | undefined,
    bytes: Buffer,
  ): Promise<string> {
    const dir = path.join(this.basePath, userId, "media", conversationId);
    this.ensureDir(dir);
    const ext = WhatsAppMediaStorageService.extensionForMime(mimeType);
    const filePath = path.join(dir, `${messageId}.${ext}`);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  }

  /** Lê arquivo do storage. Retorna null se não existir. */
  async readFile(filePath: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  }
}
