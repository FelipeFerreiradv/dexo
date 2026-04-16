import * as fs from "fs";
import * as path from "path";

/**
 * Serviço de storage para artefatos fiscais (XMLs, DANFEs).
 *
 * Armazena em filesystem local no caminho configurado por FISCAL_STORAGE_PATH.
 * Estrutura: {FISCAL_STORAGE_PATH}/{userId}/{tipo}/{arquivo}
 *
 * Tipos: xml-original, xml-autorizado, danfe
 */
export class FiscalStorageService {
  private basePath: string;

  constructor() {
    this.basePath =
      process.env.FISCAL_STORAGE_PATH ||
      path.join(process.cwd(), ".fiscal-storage");
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private getUserDir(userId: string, tipo: string): string {
    const dir = path.join(this.basePath, userId, tipo);
    this.ensureDir(dir);
    return dir;
  }

  /**
   * Salva XML original (antes da autorização).
   */
  async saveXmlOriginal(
    userId: string,
    nfeId: string,
    xml: string,
  ): Promise<string> {
    const dir = this.getUserDir(userId, "xml-original");
    const filePath = path.join(dir, `${nfeId}.xml`);
    fs.writeFileSync(filePath, xml, "utf-8");
    return filePath;
  }

  /**
   * Salva XML autorizado retornado pelo provedor/SEFAZ.
   */
  async saveXmlAutorizado(
    userId: string,
    nfeId: string,
    xml: string,
  ): Promise<string> {
    const dir = this.getUserDir(userId, "xml-autorizado");
    const filePath = path.join(dir, `${nfeId}.xml`);
    fs.writeFileSync(filePath, xml, "utf-8");
    return filePath;
  }

  /**
   * Salva DANFE PDF.
   */
  async saveDanfePdf(
    userId: string,
    nfeId: string,
    pdfBytes: Uint8Array,
  ): Promise<string> {
    const dir = this.getUserDir(userId, "danfe");
    const filePath = path.join(dir, `${nfeId}.pdf`);
    fs.writeFileSync(filePath, pdfBytes);
    return filePath;
  }

  /**
   * Lê arquivo do storage. Retorna null se não existir.
   */
  async readFile(filePath: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  }
}
