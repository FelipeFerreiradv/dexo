/**
 * Circuit breaker dos provedores de recorte (PR 5).
 *
 * POR QUE EXISTE
 * --------------
 * Quando o sidecar cai (OOM, restart), cada upload ainda paga fila no gate +
 * timeout/ECONNREFUSED antes de degradar — e o worker assíncrono queima
 * `attempts` de jobs com falha certa. O breaker transforma "falhou 5x seguidas"
 * em "pare de tentar por 60s e sonde uma vez": as requisições seguintes vão
 * direto ao próximo elo da cadeia (provedor externo, se configurado) ou à
 * degradação graceful, e o worker nem faz claim.
 *
 * SÓ falha de INFRA abre o breaker: conexão, timeout e HTTP 5xx. 4xx é erro de
 * requisição/configuração — repetir com outra imagem pode funcionar, e abrir o
 * breaker por causa dele esconderia o problema real.
 *
 * KILL-SWITCH: REMBG_BREAKER_DISABLED=1 => allow/begin sempre true e nenhum
 * estado avança — comportamento pré-PR 5 byte a byte.
 *
 * Singleton POR PROCESSO (mesma limitação consciente do rembg-gate): o estado
 * não é compartilhado entre pm2 apps, o que é aceitável — cada processo
 * descobre a queda em ≤5 chamadas próprias.
 */

const FAILURE_THRESHOLD = 5;
const OPEN_MS = 60_000;

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  /** Epoch ms da última transição de estado (diagnóstico). */
  sinceMs: number;
  lastFailure?: string;
}

function isBreakerDisabled(): boolean {
  const raw = (process.env.REMBG_BREAKER_DISABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private sinceMs = Date.now();
  /** HALF_OPEN admite UMA sonda em voo; as demais chamadas esperam o veredito. */
  private probeInFlight = false;
  private lastFailure?: string;

  /** Leitura PURA (worker consulta antes do claim): chamaríamos agora? Não
   *  muda estado nem reivindica a sonda — quem despacha usa beginAttempt(). */
  peekAllowed(): boolean {
    if (isBreakerDisabled()) return true;
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") return Date.now() - this.openedAt >= OPEN_MS;
    return !this.probeInFlight;
  }

  /**
   * Reivindica o direito de UMA tentativa. Em HALF_OPEN só a primeira chamada
   * ganha (sonda); em OPEN vencido transiciona para HALF_OPEN. Quem recebeu
   * `true` DEVE terminar em recordSuccess/recordFailure — ou abortAttempt()
   * se desistir sem despachar (gate cheio, orçamento curto), senão a sonda
   * fica presa e o breaker nunca fecha.
   */
  beginAttempt(): boolean {
    if (isBreakerDisabled()) return true;
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt < OPEN_MS) return false;
      this.transition("HALF_OPEN");
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  /** Desistiu sem chamar o provedor: devolve a sonda sem mexer nos contadores. */
  abortAttempt(): void {
    this.probeInFlight = false;
  }

  recordSuccess(): void {
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    if (this.state !== "CLOSED") this.transition("CLOSED");
  }

  recordFailure(message?: string): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (message) this.lastFailure = message.slice(0, 300);
    // Sonda falhou => reabre na hora; em CLOSED, abre no limiar.
    if (
      this.state === "HALF_OPEN" ||
      this.consecutiveFailures >= FAILURE_THRESHOLD
    ) {
      this.openedAt = Date.now();
      if (this.state !== "OPEN") this.transition("OPEN");
      else this.sinceMs = Date.now();
    }
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      sinceMs: this.sinceMs,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }

  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
    this.lastFailure = undefined;
    this.sinceMs = Date.now();
  }

  private transition(next: BreakerState): void {
    this.state = next;
    this.sinceMs = Date.now();
  }
}

/** Sidecar local (BiRefNet na VPS). */
export const localRembgBreaker = new CircuitBreaker();
/** Provedor externo de fallback (remove.bg etc.), quando configurado. */
export const externalRembgBreaker = new CircuitBreaker();

export function getBreakerSnapshots(): {
  disabled: boolean;
  local: BreakerSnapshot;
  external: BreakerSnapshot;
} {
  return {
    disabled: isBreakerDisabled(),
    local: localRembgBreaker.snapshot(),
    external: externalRembgBreaker.snapshot(),
  };
}

/** Estado é singleton de módulo — os testes precisam zerar entre casos. */
export function __resetRembgBreakers(): void {
  localRembgBreaker.reset();
  externalRembgBreaker.reset();
}
