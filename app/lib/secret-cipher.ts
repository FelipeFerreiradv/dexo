import * as crypto from "crypto";

/**
 * Cifra genérica AES-256-GCM para segredos em repouso (mesmo padrão já usado
 * para a senha do certificado A1 em certificate-manager.service.ts).
 *
 * Uso pretendido (PR-A5): cifrar accessToken/refreshToken de marketplace no
 * banco. A chave vem de `MARKETPLACE_TOKEN_ENC_KEY` (64 hex = 32 bytes).
 *
 * ROLLOUT ZERO-REGRESSÃO (importante):
 * - SEM a env definida, a cifra fica DESLIGADA (`isEnabled() === false`):
 *   `encrypt()` retorna o texto como está e `tryDecrypt()` é no-op. Ou seja,
 *   subir o código sem a chave NÃO muda nada (tokens seguem em texto plano).
 * - Quando o Felipe define a chave (após validar em staging), novas escritas
 *   passam a ser cifradas e a leitura decifra tanto o legado (texto plano) quanto
 *   o novo formato — migração transparente.
 *
 * Formato cifrado: `iv:tag:ciphertext` (tudo hex). `tryDecrypt` só tenta decifrar
 * valores nesse formato e, em qualquer erro, devolve o valor original (robusto
 * contra falso-positivo de formato).
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const ENC_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/i;

let cachedKey: Buffer | null = null;
let resolved = false;

function resolveKey(): Buffer | null {
  if (resolved) return cachedKey;
  resolved = true;
  const keyHex = (process.env.MARKETPLACE_TOKEN_ENC_KEY ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    cachedKey = Buffer.from(keyHex, "hex");
  } else {
    cachedKey = null; // sem chave válida => cifra desligada (no-op)
  }
  return cachedKey;
}

export class SecretCipher {
  /** A cifra está ativa? (chave de 32 bytes presente e válida.) */
  static isEnabled(): boolean {
    return resolveKey() !== null;
  }

  /** Um valor já está no formato cifrado `iv:tag:ct`? */
  static looksEncrypted(value: string | null | undefined): boolean {
    return typeof value === "string" && ENC_FORMAT.test(value);
  }

  /**
   * Cifra um texto. Se a cifra estiver desligada (sem chave) ou o valor for
   * vazio, devolve o valor como está (no-op seguro).
   */
  static encrypt(plain: string | null | undefined): string {
    const key = resolveKey();
    if (!key || !plain) return plain ?? "";
    if (SecretCipher.looksEncrypted(plain)) return plain; // já cifrado
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plain, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
  }

  /**
   * Decifra se o valor estiver no formato cifrado E a chave estiver presente.
   * Caso contrário (legado em texto plano, vazio, ou erro), devolve o original.
   */
  static tryDecrypt(value: string | null | undefined): string {
    const key = resolveKey();
    if (!key || !value || !SecretCipher.looksEncrypted(value)) {
      return value ?? "";
    }
    try {
      const [ivHex, tagHex, ct] = value.split(":");
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(ivHex, "hex"),
      );
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      let decrypted = decipher.update(ct, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      // Falso-positivo de formato ou chave errada: devolve o original.
      return value;
    }
  }
}
