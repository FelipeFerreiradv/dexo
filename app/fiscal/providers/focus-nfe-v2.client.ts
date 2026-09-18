/**
 * Cliente HTTP do Focus NFe para a numeração V2.
 *
 * Por que existe (e por que NÃO reaproveita focus-nfe.provider.ts, que fica
 * intacto): o provider V1 chama `res.json()` sem checar o corpo (o 401 do Focus
 * vem em HTML e vira exceção), não tem timeout, trata qualquer 200 como
 * sucesso na inutilização e deixa `status_sefaz` como string no cStat. A V2
 * precisa do BRUTO fiel para classificar (app/fiscal/numeracao):
 *
 *  - `res.text()` + `JSON.parse` protegido (HTML/vazio ⇒ `corpo: null`);
 *  - `AbortSignal.timeout` no POST e no GET ⇒ `transporte: "TIMEOUT"`;
 *    falha de rede ⇒ `"REDE"`; NUNCA lança;
 *  - só os campos de `FocusV2Corpo`; `chave_nfe` normalizada para 44 dígitos;
 *  - `Retry-After` (segundos ou data HTTP) em ms;
 *  - token e headers NUNCA aparecem no resultado nem em mensagem.
 *
 * Constantes de URL duplicadas de propósito (não importar do V1).
 */

import { focusPostTimeoutMs, focusGetTimeoutMs } from "../flags";
import { normalizarCStat } from "../numeracao/cstat";
import type {
  FocusV2Corpo,
  FocusV2Resposta,
  Transporte,
} from "../numeracao/tipos";

const FOCUS_HOMOLOG = "https://homologacao.focusnfe.com.br";
const FOCUS_PROD = "https://api.focusnfe.com.br";

/** POST pode esperar a SEFAZ síncrona; GET é leitura. */
export const FOCUS_V2_POST_TIMEOUT_MS_PADRAO = 45_000;
export const FOCUS_V2_GET_TIMEOUT_MS_PADRAO = 15_000;

export interface FocusNfeV2ClientOpts {
  fetchImpl?: typeof fetch;
  postTimeoutMs?: number;
  getTimeoutMs?: number;
}

export interface FocusV2InutilizacaoInput {
  cnpj: string;
  serie: number;
  numeroInicial: number;
  numeroFinal: number;
  justificativa: string;
}

export type FocusV2InutilizacaoResposta = FocusV2Resposta & {
  /** Só com `status === "autorizado"` E cStat 102 (inutilização homologada). */
  sucesso: boolean;
  protocolo: string | null;
};

export class FocusNfeV2Client {
  private readonly baseUrl: string;
  private readonly path: "nfe" | "nfce";
  private readonly fetchImpl: typeof fetch;
  private readonly postTimeoutMs: number;
  private readonly getTimeoutMs: number;

  constructor(
    ambiente: "HOMOLOGACAO" | "PRODUCAO",
    modelo: "55" | "65",
    opts?: FocusNfeV2ClientOpts,
  ) {
    this.baseUrl = ambiente === "PRODUCAO" ? FOCUS_PROD : FOCUS_HOMOLOG;
    this.path = modelo === "65" ? "nfce" : "nfe";
    // Resolve o fetch global na CHAMADA (não na construção).
    this.fetchImpl = opts?.fetchImpl ?? ((input, init) => fetch(input, init));
    this.postTimeoutMs = timeoutValido(
      opts?.postTimeoutMs ?? focusPostTimeoutMs(),
      FOCUS_V2_POST_TIMEOUT_MS_PADRAO,
    );
    this.getTimeoutMs = timeoutValido(
      opts?.getTimeoutMs ?? focusGetTimeoutMs(),
      FOCUS_V2_GET_TIMEOUT_MS_PADRAO,
    );
  }

  /** POST /v2/{nfe|nfce}?ref= — envia o payload JSON. Nunca lança. */
  async emitir(
    payload: Record<string, unknown>,
    ref: string,
    token: string,
  ): Promise<FocusV2Resposta> {
    const url = `${this.baseUrl}/v2/${this.path}?ref=${encodeURIComponent(ref)}`;
    return this.requisitar(url, "POST", token, payload, this.postTimeoutMs);
  }

  /** GET /v2/{nfe|nfce}/{ref}?completa=0 — situação da ref. Nunca lança. */
  async consultar(ref: string, token: string): Promise<FocusV2Resposta> {
    const url = `${this.baseUrl}/v2/${this.path}/${encodeURIComponent(ref)}?completa=0`;
    return this.requisitar(url, "GET", token, undefined, this.getTimeoutMs);
  }

  /**
   * POST /v2/{nfe|nfce}/inutilizacao. `sucesso` só com `status: "autorizado"`
   * e `status_sefaz` 102 — HTTP 200 com `erro_autorizacao` é FALHA (o V1
   * trata qualquer 200 como sucesso). Nunca lança.
   */
  async inutilizar(
    input: FocusV2InutilizacaoInput,
    token: string,
  ): Promise<FocusV2InutilizacaoResposta> {
    const url = `${this.baseUrl}/v2/${this.path}/inutilizacao`;
    const resp = await this.requisitar(
      url,
      "POST",
      token,
      {
        cnpj: input.cnpj,
        serie: String(input.serie),
        numero_inicial: String(input.numeroInicial),
        numero_final: String(input.numeroFinal),
        justificativa: input.justificativa,
      },
      this.postTimeoutMs,
    );
    const corpo = resp.corpo;
    const sucesso =
      corpo !== null &&
      corpo.status === "autorizado" &&
      normalizarCStat(corpo.status_sefaz) === 102;
    return {
      ...resp,
      sucesso,
      protocolo: corpo?.protocolo_sefaz ?? corpo?.protocolo ?? null,
    };
  }

  private async requisitar(
    url: string,
    metodo: "GET" | "POST",
    token: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<FocusV2Resposta> {
    let res: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Basic ${Buffer.from(`${token ?? ""}:`).toString("base64")}`,
      };
      const init: RequestInit = {
        method: metodo,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      res = await this.fetchImpl(url, init);
    } catch (error) {
      return semResposta(transporteDaFalha(error), null, null);
    }

    const httpStatus = typeof res?.status === "number" ? res.status : null;
    const retryAfterMs = lerRetryAfterMs(res);

    let texto: string;
    try {
      texto = await res.text();
    } catch (error) {
      // Cabeçalho chegou, corpo não (abort/conexão caiu no meio): incerto.
      return semResposta(transporteDaFalha(error), httpStatus, retryAfterMs);
    }

    return {
      httpStatus,
      transporte: null,
      corpo: extrairCorpo(texto, token),
      retryAfterMs,
    };
  }
}

// ───────────────────────────── helpers puros ─────────────────────────────

function timeoutValido(valor: number | undefined, padrao: number): number {
  return typeof valor === "number" && Number.isFinite(valor) && valor > 0
    ? Math.floor(valor)
    : padrao;
}

function semResposta(
  transporte: Transporte,
  httpStatus: number | null,
  retryAfterMs: number | null,
): FocusV2Resposta {
  return { httpStatus, transporte, corpo: null, retryAfterMs };
}

/** Abort/timeout ⇒ TIMEOUT; qualquer outra falha antes da resposta ⇒ REDE. */
function transporteDaFalha(error: unknown): "TIMEOUT" | "REDE" {
  if (error && typeof error === "object") {
    const nome = String((error as { name?: unknown }).name ?? "");
    if (nome === "TimeoutError" || nome === "AbortError") return "TIMEOUT";
    const causa = (error as { cause?: unknown }).cause;
    const code = String(
      (error as { code?: unknown }).code ??
        (causa && typeof causa === "object"
          ? ((causa as { code?: unknown }).code ?? "")
          : ""),
    );
    if (
      code === "ETIMEDOUT" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT"
    ) {
      return "TIMEOUT";
    }
  }
  return "REDE";
}

/** `Retry-After`: segundos inteiros ou data HTTP ⇒ ms (≥ 0); ausente/inválido ⇒ null. */
export function parseRetryAfterMs(
  valor: string | null | undefined,
  agoraMs: number = Date.now(),
): number | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (!texto) return null;
  if (/^\d+$/.test(texto)) {
    const segundos = Number(texto);
    return Number.isSafeInteger(segundos) ? segundos * 1000 : null;
  }
  // HTTP-date sempre tem nome de dia/mês ("Wed, 16 Sep 2026 12:00:00 GMT");
  // sem isso, o Date.parse do V8 aceitaria "-5" como ano.
  if (!/[A-Za-z]{3}/.test(texto)) return null;
  const quando = Date.parse(texto);
  if (!Number.isFinite(quando)) return null;
  return Math.max(0, quando - agoraMs);
}

function lerRetryAfterMs(res: Response): number | null {
  try {
    return parseRetryAfterMs(res.headers?.get("retry-after"));
  } catch {
    return null;
  }
}

/** "NFe3526…" / com pontuação ⇒ 44 dígitos; qualquer outra coisa ⇒ null. */
export function normalizarChaveFocus(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const digitos = valor.trim().replace(/^NFe/i, "").replace(/\D/g, "");
  return digitos.length === 44 ? digitos : null;
}

/** Campos de texto que o Focus pode mandar como `null`. */
const CAMPOS_TEXTO_ANULAVEIS = [
  "mensagem_sefaz",
  "codigo",
  "mensagem",
  "protocolo",
  "protocolo_sefaz",
  "data_evento",
  "caminho_xml_nota_fiscal",
] as const;

const CAMPOS_TEXTO_OU_NUMERO = ["status_sefaz", "numero", "serie"] as const;

/**
 * JSON do Focus ⇒ só os campos de FocusV2Corpo, com tipo conferido. Corpo que
 * não é objeto JSON (HTML do 401, vazio, lista) ⇒ null. Se, por qualquer
 * motivo, um texto devolvido contiver o token, ele é mascarado.
 */
function extrairCorpo(texto: string, token: string): FocusV2Corpo | null {
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const bruto = json as Record<string, unknown>;
  const limpar = mascararToken(token);
  const corpo: FocusV2Corpo = {};

  if (typeof bruto.status === "string") corpo.status = limpar(bruto.status);
  for (const campo of CAMPOS_TEXTO_ANULAVEIS) {
    const v = bruto[campo];
    if (typeof v === "string") corpo[campo] = limpar(v);
    else if (v === null) corpo[campo] = null;
  }
  for (const campo of CAMPOS_TEXTO_OU_NUMERO) {
    const v = bruto[campo];
    if (typeof v === "string") corpo[campo] = limpar(v);
    else if (typeof v === "number" && Number.isFinite(v)) corpo[campo] = v;
    else if (v === null) corpo[campo] = null;
  }
  if ("chave_nfe" in bruto) {
    corpo.chave_nfe = normalizarChaveFocus(bruto.chave_nfe);
  }
  if (Array.isArray(bruto.erros)) {
    corpo.erros = bruto.erros
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => {
        const item: { mensagem?: string; campo?: string; codigo?: string } = {};
        if (typeof e.mensagem === "string") item.mensagem = limpar(e.mensagem);
        if (typeof e.campo === "string") item.campo = limpar(e.campo);
        if (typeof e.codigo === "string") item.codigo = limpar(e.codigo);
        return item;
      });
  }
  return corpo;
}

function mascararToken(token: string): (texto: string) => string {
  const t = typeof token === "string" ? token.trim() : "";
  if (t.length < 4) return (texto) => texto;
  return (texto) => texto.split(t).join("[REDACTED]");
}
