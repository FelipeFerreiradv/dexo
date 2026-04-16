import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Gerenciador de certificados digitais A1 (.pfx).
 *
 * Responsabilidades:
 * - Encriptar/descriptografar a senha do certificado
 * - Validar existência e expiração do certificado
 *
 * A chave de encriptação vem da env FISCAL_CERT_ENC_KEY (32 bytes hex).
 * O Focus NFe cuida da assinatura XML — aqui só gerenciamos o storage seguro.
 */
export class CertificateManagerService {
  private encKey: Buffer;

  constructor() {
    const keyHex = process.env.FISCAL_CERT_ENC_KEY;
    if (keyHex && keyHex.length >= 64) {
      this.encKey = Buffer.from(keyHex.slice(0, 64), "hex");
    } else {
      // Fallback para desenvolvimento — NÃO usar em produção
      this.encKey = crypto.scryptSync("dev-fiscal-key", "salt", 32);
    }
  }

  /**
   * Encripta a senha do certificado para armazenamento seguro no banco.
   */
  encryptPassword(plainPassword: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encKey, iv);

    let encrypted = cipher.update(plainPassword, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();

    // formato: iv:tag:ciphertext (tudo hex)
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
  }

  /**
   * Descriptografa a senha armazenada.
   */
  decryptPassword(encryptedPassword: string): string {
    const parts = encryptedPassword.split(":");
    if (parts.length !== 3) {
      throw new Error("Formato de senha encriptada invalido");
    }

    const iv = Buffer.from(parts[0], "hex");
    const tag = Buffer.from(parts[1], "hex");
    const ciphertext = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, this.encKey, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Valida se o certificado está dentro da validade.
   */
  isValid(validoAte: Date | null): boolean {
    if (!validoAte) return false;
    return new Date() < validoAte;
  }
}
