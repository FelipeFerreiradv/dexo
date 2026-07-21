/**
 * Orçamento de tempo do caminho de remoção de fundo.
 *
 * PROBLEMA QUE ISSO RESOLVE
 * -------------------------
 * `POST /upload/image` roda atrás do nginx. Quando o handler demora mais que o
 * `proxy_read_timeout` do vhost, quem responde é o NGINX (504), não o Fastify —
 * e a resposta dele não passa pelo `@fastify/cors`. O browser então descarta a
 * resposta ("Access-Control-Allow-Origin missing"), o `fetch` rejeita e o modal
 * perde a imagem.
 *
 * O serviço JÁ tem degradação graceful (200 + WebP + `warning`), mas ela era
 * inalcançável: o `REMBG_TIMEOUT_MS` default é 60000 — IGUAL ao default de
 * fábrica do nginx —, e o axios cobre apenas 1 dos 9 `await` do handler. Quando
 * ele finalmente aborta, o nginx já cortou. O fallback virava dead code.
 *
 * A CORREÇÃO: DEADLINE POR REQUISIÇÃO, NÃO TIMEOUT FIXO MENOR
 * -----------------------------------------------------------
 * Baixar `REMBG_TIMEOUT_MS` para um valor fixo converteria uploads que HOJE dão
 * certo (fila longa, mas dentro do orçamento do proxy) em WebP-sem-recorte —
 * regressão silenciosa de qualidade. Em vez disso, a rota carimba um `deadlineAt`
 * e o timeout do sidecar passa a ser:
 *
 *     min(REMBG_TIMEOUT_MS, deadlineAt - agora - RESERVE_MS)
 *
 * O `min` garante que o env só pode REDUZIR o orçamento, nunca aumentá-lo, e o
 * deadline só morde quando a requisição seria cortada pelo nginx de qualquer
 * jeito. Sem `deadlineAt`, o comportamento é byte-a-byte o de hoje.
 */

/** Default histórico do timeout do sidecar (mantido para não mudar o caminho feliz). */
export const REMBG_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Orçamento fim-a-fim do handler, do primeiro byte do multipart até o
 * `reply.send`. Precisa ficar CONFORTAVELMENTE abaixo do `proxy_read_timeout`
 * do nginx (default de fábrica: 60s). 45s deixa ~12s de folga mesmo no pior
 * caso medido de trabalho fora do relógio do axios.
 */
export const HANDLER_BUDGET_DEFAULT_MS = 45_000;

/**
 * Tempo reservado para o que ainda roda DEPOIS de o sidecar estourar: encode
 * WebP do fallback (~0,6s), `metadata()` e o write em disco da processada
 * (~0,2s), mais margem para contenção do threadpool do libuv (sharp roda lá, e
 * `UV_THREADPOOL_SIZE` é 4 por default). p95 medido ~3s.
 */
export const SIDECAR_RESERVE_MS = 3_000;

/**
 * Abaixo disso não vale a pena nem abrir a conexão.
 *
 * Calibrado no PISO REAL de inferência do BiRefNet em CPU: ~7s/img
 * (`infra/rembg/README.md:64`; mediana medida no KVM8 ~9s). O ponto é que o
 * `remove()` do sidecar é SÍNCRONO e NÃO-CANCELÁVEL (`infra/rembg/app.py`): se
 * despacharmos com menos que isso de sobra, o cliente desiste no meio e o único
 * worker fica ~9s produzindo um recorte que ninguém vai ler — roubando a vez de
 * quem ainda tinha orçamento. Um limiar baixo (ex.: 1s) deixaria passar
 * exatamente esse desperdício.
 */
export const SIDECAR_MIN_USEFUL_MS = 7_000;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Timeout do sidecar configurado no ambiente. Lido por chamada (não em escopo
 * de módulo) para que testes e `pm2 restart --update-env` funcionem.
 */
export function readRembgTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveInt(env.REMBG_TIMEOUT_MS, REMBG_DEFAULT_TIMEOUT_MS);
}

/**
 * Orçamento fim-a-fim do handler. `UPLOAD_HANDLER_BUDGET_MS` permite ajustar
 * sem deploy caso o `proxy_read_timeout` real da VPS seja diferente de 60s.
 */
export function readHandlerBudgetMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveInt(
    env.UPLOAD_HANDLER_BUDGET_MS,
    HANDLER_BUDGET_DEFAULT_MS,
  );
}

export interface SidecarTimeoutInput {
  /** Instante (epoch ms) em que o handler precisa ter respondido. */
  deadlineAt?: number;
  /** Agora (epoch ms). Injetável para teste determinístico. */
  now?: number;
  /** Teto vindo do ambiente. */
  rembgTimeoutMs?: number;
  /** Tempo guardado para o fallback pós-timeout. */
  reserveMs?: number;
}

/**
 * Quanto tempo o round-trip ao sidecar ainda pode consumir.
 *
 * - Sem `deadlineAt` → devolve o timeout do ambiente (comportamento de hoje).
 * - Com `deadlineAt` → devolve `min(env, tempo restante - reserva)`.
 * - Valor `<= 0` significa "não chame o sidecar": vá direto ao fallback. Isso
 *   evita a work amplification de disparar uma inferência de ~9s que ninguém
 *   vai esperar (o sidecar tem 1 worker e não cancela trabalho já iniciado).
 */
export function computeSidecarTimeoutMs(
  input: SidecarTimeoutInput = {},
): number {
  const rembgTimeoutMs = input.rembgTimeoutMs ?? readRembgTimeoutMs();
  const { deadlineAt } = input;

  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
    return rembgTimeoutMs;
  }

  const now = input.now ?? Date.now();
  const reserveMs = input.reserveMs ?? SIDECAR_RESERVE_MS;
  const remaining = deadlineAt - now - reserveMs;

  return Math.min(rembgTimeoutMs, remaining);
}

/** Açúcar de leitura: o orçamento restante dá para tentar o sidecar? */
export function isWorthCallingSidecar(timeoutMs: number): boolean {
  return timeoutMs >= SIDECAR_MIN_USEFUL_MS;
}
