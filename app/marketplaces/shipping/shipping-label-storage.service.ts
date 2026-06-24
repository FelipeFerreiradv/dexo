import * as fs from "fs";
import * as path from "path";

/**
 * Storage de PDFs de etiqueta de envio. Espelha o padrão do
 * FiscalStorageService, mas em base própria (NÃO mistura com `.fiscal-storage`).
 *
 * Base: SHIPPING_STORAGE_PATH || {cwd}/.shipping-storage
 * Estrutura: {base}/{userId}/etiquetas/{orderId}-{size}.pdf
 */
export class ShippingLabelStorageService {
  private basePath: string;

  constructor() {
    this.basePath =
      process.env.SHIPPING_STORAGE_PATH ||
      path.join(process.cwd(), ".shipping-storage");
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private getUserDir(userId: string): string {
    const dir = path.join(this.basePath, userId, "etiquetas");
    this.ensureDir(dir);
    return dir;
  }

  /**
   * Salva o PDF da etiqueta. `size` entra no nome para coexistirem A4 e térmico
   * do mesmo pedido. Reemissão sobrescreve o arquivo anterior do mesmo par.
   */
  async saveLabelPdf(
    userId: string,
    orderId: string,
    size: string,
    pdfBytes: Uint8Array,
  ): Promise<string> {
    const dir = this.getUserDir(userId);
    const filePath = path.join(dir, `${orderId}-${size}.pdf`);
    fs.writeFileSync(filePath, pdfBytes);
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
