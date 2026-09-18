/**
 * Cifragem de segredos fiscais em repouso (ex.: CSRT do responsável técnico).
 *
 * Reusa EXATAMENTE a cifragem da senha do certificado A1
 * (`CertificateManagerService.encryptPassword/decryptPassword`: AES-256-GCM,
 * chave `FISCAL_CERT_ENC_KEY`, formato `iv:tag:ciphertext`), inclusive o
 * fail-closed em produção sem chave. Não existe segunda chave nem segundo
 * formato.
 *
 * A instância é criada só no primeiro uso (importar este módulo não lê env
 * nem aborta o boot).
 *
 * Servidor apenas: nunca importar em código de client.
 */

import { CertificateManagerService } from "./certificate-manager.service";

let manager: CertificateManagerService | null = null;

function getManager(): CertificateManagerService {
  if (!manager) {
    manager = new CertificateManagerService();
  }
  return manager;
}

export function encryptFiscalSecret(plain: string): string {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("Segredo fiscal vazio nao pode ser cifrado");
  }
  return getManager().encryptPassword(plain);
}

export function decryptFiscalSecret(enc: string): string {
  if (typeof enc !== "string" || enc.length === 0) {
    throw new Error("Segredo fiscal cifrado ausente");
  }
  const m = getManager();
  try {
    return m.decryptPassword(enc);
  } catch {
    // Mensagem própria e sem `cause`: a falha nunca carrega o conteúdo cifrado.
    throw new Error(
      "Segredo fiscal ilegivel: formato invalido ou cifrado com outra FISCAL_CERT_ENC_KEY",
    );
  }
}
