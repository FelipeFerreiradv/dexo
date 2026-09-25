/**
 * Cliente HTTP do Focus NFe para a numeração V2.
 *
 * Por que existe (e por que NÃO reaproveita focus-nfe.provider.ts, que fica
 * intacto): o provider V1 chama `res.json()` sem checar o corpo (o 401 do Focus
 * vem em HTML e vira exceção), não tem timeout, até 25/09/2026 tratava qualquer
 * 200 como sucesso na inutilização (hoje "erro_autorizacao" é falha, exceto
 * 206/563 — "já inutilizada" —, que são sucesso idempotente) e deixa
 * `status_sefaz` como string no cStat. A V2
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

/** cStat do evento de cancelamento homologado: 135 (no prazo) e 155 (fora do prazo). */
const CSTAT_CANCELAMENTO_OK: readonly number[] = [135, 155];

export type FocusV2CancelamentoResposta = FocusV2Resposta & {
  /** Só com HTTP 200, `status === "cancelado"` E cStat 135/155. */
  sucesso: boolean;
  protocolo: string | null;
  /** `status_sefaz` normalizado (null quando ausente/não numérico). */
  cStat: number | null;
  /** Texto para o usuário/auditoria (nunca contém o token). */
  mensagem: string;
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

  /**
   * GET /v2/{nfe|nfce}/{ref}?completa=1 — situação da ref. Nunca lança.
   * `completa=1` porque só assim a Focus devolve o protocolo de autorização
   * (`protocolo` / `protocolo_nota_fiscal.numero_protocolo`) e a data de
   * recebimento; com `completa=0` a autorização vem sem protocolo.
   */
  async consultar(ref: string, token: string): Promise<FocusV2Resposta> {
    const url = `${this.baseUrl}/v2/${this.path}/${encodeURIComponent(ref)}?completa=1`;
    return this.requisitar(url, "GET", token, undefined, this.getTimeoutMs);
  }

  /**
   * POST /v2/{nfe|nfce}/inutilizacao. `sucesso` só com `status: "autorizado"`
   * e `status_sefaz` 102 — HTTP 200 com `erro_autorizacao` é FALHA, inclusive
   * 206/563 ("já inutilizada"). Até 25/09/2026 o V1 tratava qualquer 200 como
   * sucesso; hoje o V1 também trata `erro_autorizacao` como falha, exceto
   * 206/563, que lá são sucesso idempotente (aqui não). Nunca lança.
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

  /**
   * DELETE /v2/{nfe|nfce}/{ref} — cancelamento da nota autorizada NAQUELA ref.
   * `sucesso` só com HTTP 200, `status: "cancelado"` e `status_sefaz` 135/155.
   * HTTP 200 com `erro_cancelamento` (SEFAZ recusou o evento) é FALHA, inclusive
   * 218/420 ("já cancelada"). Até 25/09/2026 o V1 tratava qualquer 200 como
   * sucesso; hoje o V1 também trata `erro_cancelamento` como falha, exceto
   * 218/420, que lá são sucesso idempotente (aqui não). Status desconhecido,
   * corpo ilegível ou falha de transporte também são falha (nunca marcar
   * cancelada sem prova). Nunca lança.
   */
  async cancelar(
    ref: string,
    justificativa: string,
    token: string,
  ): Promise<FocusV2CancelamentoResposta> {
    const url = `${this.baseUrl}/v2/${this.path}/${encodeURIComponent(ref)}`;
    const resp = await this.requisitar(
      url,
      "DELETE",
      token,
      { justificativa },
      this.postTimeoutMs,
    );
    const corpo = resp.corpo;
    const cStat = normalizarCStat(corpo?.status_sefaz);
    const sucesso =
      resp.httpStatus === 200 &&
      corpo !== null &&
      corpo.status === "cancelado" &&
      cStat !== null &&
      CSTAT_CANCELAMENTO_OK.includes(cStat);
    const textoProvedor = corpo?.mensagem_sefaz ?? corpo?.mensagem ?? null;
    let mensagem: string;
    if (sucesso) {
      mensagem = textoProvedor ?? "Cancelamento homologado";
    } else if (resp.transporte) {
      mensagem =
        "Sem resposta do provedor ao cancelar — consulte a situação da NF-e antes de tentar de novo";
    } else if (corpo?.status === "erro_cancelamento") {
      mensagem = textoProvedor ?? "Cancelamento recusado pela SEFAZ";
    } else if (resp.httpStatus === 200) {
      mensagem =
        "Resposta do provedor sem confirmação do cancelamento — consulte a situação da NF-e antes de tentar de novo";
    } else {
      mensagem =
        textoProvedor ??
        `Cancelamento não aceito pelo provedor (HTTP ${resp.httpStatus ?? "?"})`;
    }
    return {
      ...resp,
      sucesso,
      protocolo: corpo?.protocolo ?? corpo?.protocolo_sefaz ?? null,
      cStat,
      mensagem,
    };
  }

  private async requisitar(
    url: string,
    metodo: "GET" | "POST" | "DELETE",
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
  // Consulta completa: o protocolo também vem em protocolo_nota_fiscal.
  const prot = bruto.protocolo_nota_fiscal;
  if (prot && typeof prot === "object" && !Array.isArray(prot)) {
    const p = prot as Record<string, unknown>;
    if (corpo.protocolo == null && typeof p.numero_protocolo === "string" && p.numero_protocolo.trim()) {
      corpo.protocolo = limpar(p.numero_protocolo.trim());
    }
    if (typeof p.data_recebimento === "string") corpo.data_recebimento = limpar(p.data_recebimento);
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
