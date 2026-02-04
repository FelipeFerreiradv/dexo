import { randomBytes, createHash } from "crypto";
import { ML_CONSTANTS } from "../mercado-livre/ml-constants";
import { PKCEData } from "../types/ml-oauth.types";

/**
 * Serviço para gerenciar PKCE (Proof Key for Public Clients)
 * Segurança adicional para fluxo OAuth em aplicações públicas
 */
export class PKCEService {
  /**
   * Gera um code_verifier aleatório
   * PKCE requer string aleatória de 43-128 caracteres
   */
  static generateCodeVerifier(): string {
    const length = ML_CONSTANTS.PKCE_CODE_LENGTH;
    const alphabet = ML_CONSTANTS.PKCE_CODE_ALPHABET;

    let verifier = "";
    const randomBytes_ = randomBytes(length);

    for (let i = 0; i < length; i++) {
      verifier += alphabet[randomBytes_[i] % alphabet.length];
    }

    return verifier;
  }

  /**
   * Gera o code_challenge a partir do code_verifier
   * code_challenge = BASE64URL(SHA256(code_verifier))
   */
  static generateCodeChallenge(codeVerifier: string): string {
    return createHash("sha256")
      .update(codeVerifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  /**
   * Gera ambos code_verifier e code_challenge
   */
  static generatePKCEPair(): PKCEData {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);

    return {
      codeVerifier,
      codeChallenge,
    };
  }
}
