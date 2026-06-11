import * as fs from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";
import axios, { type AxiosInstance } from "axios";

import type { LoadedCertificate } from "../certificate/certificate-loader.service";

/**
 * Cliente SOAP 1.2 sobre HTTPS com mTLS, usado para falar com webservices da
 * SEFAZ (NFeAutorizacao4, NfeStatusServico4, RecepcaoEvento4, etc).
 *
 * Responsabilidades:
 *   - Construir o `https.Agent` com cert + key + CA (mTLS obrigatório SEFAZ).
 *   - Setar headers SOAP 1.2 corretos (Content-Type com `action` quando aplicável).
 *   - Aplicar timeout configurável e retry com backoff exponencial para falhas
 *     transientes (timeouts, ECONNRESET, 5xx).
 *   - Persistir request/response como artefatos para auditoria (opt-in via
 *     callback — o cliente em si não conhece o storage do projeto).
 *
 * NÃO valida XML de resposta nem parseia cStat — isso é responsabilidade dos
 * helpers de cada serviço SEFAZ.
 */

export interface SoapRequest {
  endpointUrl: string;
  /** Envelope SOAP 1.2 completo (já com soap:Envelope/Body construído). */
  envelope: string;
  /**
   * Valor do parâmetro `action` no Content-Type (RFC 3902). Quando omitido,
   * Content-Type é enviado sem action (alguns endpoints SEFAZ funcionam, outros
   * exigem — preferir sempre passar).
   */
  soapAction?: string;
  certificate: LoadedCertificate;
  timeoutMs?: number;
  /** Default 3. Use 0 para desabilitar retry. */
  retryMax?: number;
  /** Default 500ms (cresce exponencialmente). */
  retryBaseMs?: number;
  /** Path absoluto para CA bundle adicional (caso SEFAZ_CA_BUNDLE_PATH esteja setado). */
  caBundlePath?: string;
}

export interface SoapResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  durationMs: number;
}

export class SoapClientService {
  private agentCache = new Map<string, https.Agent>();
  private clientCache = new Map<string, AxiosInstance>();

  async send(req: SoapRequest): Promise<SoapResponse> {
    const timeoutMs = req.timeoutMs ?? defaultTimeout();
    const retryMax = req.retryMax ?? defaultRetry();
    const retryBaseMs = req.retryBaseMs ?? 500;
    const caBundlePath = req.caBundlePath ?? defaultCaBundle();

    const agentKey = buildAgentKey(req.certificate, caBundlePath);
    let agent = this.agentCache.get(agentKey);
    if (!agent) {
      agent = buildAgent(req.certificate, caBundlePath);
      this.agentCache.set(agentKey, agent);
    }

    let client = this.clientCache.get(agentKey);
    if (!client) {
      client = axios.create({
        httpsAgent: agent,
        timeout: timeoutMs,
        transitional: { clarifyTimeoutError: true },
        validateStatus: () => true,
        maxRedirects: 0,
        // Resposta como texto puro — sempre XML/SOAP, queremos parsear nós mesmos.
        responseType: "text",
        // Não transformar request body — envelope vai como string.
        transformRequest: [(body) => body],
      });
      this.clientCache.set(agentKey, client);
    }

    const contentType = req.soapAction
      ? `application/soap+xml; charset=utf-8; action="${req.soapAction}"`
      : "application/soap+xml; charset=utf-8";

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Accept: "application/soap+xml, text/xml, */*",
    };

    const started = Date.now();
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retryMax; attempt++) {
      try {
        const response = await client.post<string>(req.endpointUrl, req.envelope, {
          headers,
        });

        const durationMs = Date.now() - started;
        const responseHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(response.headers ?? {})) {
          responseHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }

        // 5xx → retry; 4xx e 2xx → devolve para o caller decidir.
        if (response.status >= 500 && attempt < retryMax) {
          await delay(backoff(retryBaseMs, attempt));
          continue;
        }

        return {
          status: response.status,
          body: typeof response.data === "string" ? response.data : String(response.data),
          headers: responseHeaders,
          durationMs,
        };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt >= retryMax) {
          throw normalizeNetworkError(error);
        }
        await delay(backoff(retryBaseMs, attempt));
      }
    }

    throw normalizeNetworkError(lastError);
  }

  /**
   * Limpa cache de agents/clients. Útil quando certificado é renovado.
   */
  reset(): void {
    for (const agent of this.agentCache.values()) {
      agent.destroy();
    }
    this.agentCache.clear();
    this.clientCache.clear();
  }
}

/**
 * Monta as opções TLS do https.Agent. Exportado para teste.
 *
 * Distinção crítica (a confusão entre as duas causava "unable to get local
 * issuer certificate" para A1 que embute a cadeia ICP-Brasil):
 *
 *   - `cert`: a cadeia do NOSSO certificado cliente (A1) apresentada ao servidor
 *     no handshake mTLS = certificado folha + intermediários (`caChainPem`).
 *     Alguns endpoints SEFAZ exigem a cadeia completa para validar o cliente.
 *
 *   - `ca`: as CAs em que NÓS confiamos para verificar o certificado do SERVIDOR
 *     SEFAZ. Deve ser o trust store padrão do Node (Mozilla/sistema) — NUNCA a
 *     cadeia do nosso A1. Passar `ca` SUBSTITUI o trust store padrão; com a
 *     cadeia do A1 ali, a verificação do servidor falha pois o emissor dele não
 *     está na lista. Um bundle extra (SEFAZ_CA_BUNDLE_PATH) é ANEXADO ao padrão.
 */
export function buildAgentOptions(
  cert: LoadedCertificate,
  caBundlePath: string | null,
): https.AgentOptions {
  // Cadeia do cliente apresentada ao servidor: folha + intermediários.
  const clientChain = [cert.certificatePem, ...cert.caChainPem]
    .map((pem) => pem.trim())
    .filter((pem) => pem.length > 0)
    .join("\n");

  let ca: string[] | undefined;
  if (caBundlePath) {
    let extra: string;
    try {
      extra = fs.readFileSync(caBundlePath, "utf8");
    } catch (error) {
      throw new Error(
        `Falha ao carregar SEFAZ_CA_BUNDLE_PATH=${caBundlePath}: ${(error as Error).message}`,
      );
    }
    // Anexa ao bundle padrão (sem ele, setar `ca` perderia as CAs do sistema).
    ca = [...tls.rootCertificates, extra];
  }

  return {
    cert: clientChain,
    key: cert.privateKeyPem,
    ca, // undefined → mantém o trust store padrão do Node
    keepAlive: true,
    // SEFAZ aceita TLS 1.2; alguns endpoints ainda têm problemas com TLS 1.3.
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  };
}

function buildAgent(cert: LoadedCertificate, caBundlePath: string | null): https.Agent {
  return new https.Agent(buildAgentOptions(cert, caBundlePath));
}

function buildAgentKey(cert: LoadedCertificate, caBundlePath: string | null): string {
  return `${cert.subjectCN ?? "?"}|${cert.notAfter.toISOString()}|${caBundlePath ?? ""}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(base: number, attempt: number): number {
  return Math.min(base * Math.pow(2, attempt), 8000);
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  );
}

function normalizeNetworkError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function defaultTimeout(): number {
  const v = process.env.SEFAZ_TIMEOUT_MS;
  const parsed = v ? Number(v) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function defaultRetry(): number {
  const v = process.env.SEFAZ_RETRY_MAX;
  const parsed = v ? Number(v) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

function defaultCaBundle(): string | null {
  const v = process.env.SEFAZ_CA_BUNDLE_PATH;
  return v && v.trim().length > 0 ? v.trim() : null;
}
