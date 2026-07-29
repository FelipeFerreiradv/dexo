/**
 * Gate de concorrência do sidecar rembg.
 *
 * POR QUE EXISTE
 * --------------
 * O sidecar tem 1 worker e a inferência roda BLOQUEANDO o event loop
 * (`infra/rembg/app.py`: handler `async def` chamando `remove()` síncrono). Com
 * isso as requisições nem chegam ao FastAPI — empilham na accept queue do
 * kernel, invisíveis, sem backpressure. Quem pede depois espera a soma de tudo
 * que está na frente.
 *
 * Pior: o MESMO sidecar atende dois consumidores — o modal de criação de
 * produto (`POST /upload/image`) e o endpoint público (`POST /v1/images/process`,
 * usado pelo Desmont Hub). Uma rajada externa enche a fila e o modal do usuário
 * estoura o orçamento do proxy.
 *
 * O QUE ESTE GATE FAZ
 * -------------------
 *  1. Limita quantas inferências ficam em voo (`REMBG_MAX_CONCURRENCY`, default
 *     2 = 1 executando + 1 com os bytes já no socket, para o sidecar emendar a
 *     próxima sem gap de round-trip).
 *  2. Reserva capacidade para o tráfego INTERNO: a lane `public` nunca ocupa
 *     mais que `REMBG_PUBLIC_MAX_CONCURRENCY` (default 1), então sempre sobra
 *     slot para o modal. O Desmont Hub deixa de conseguir starvar o upload.
 *  3. A espera é LIMITADA pelo orçamento da requisição. Se o slot não sair a
 *     tempo, `acquire` devolve `null` e o chamador degrada na hora (200 + WebP +
 *     `warning`) em vez de enfileirar trabalho que ninguém vai esperar.
 *
 * Killswitch: `REMBG_GATE_DISABLED=1` volta ao comportamento anterior (sem
 * limite), seguindo a convenção dos demais kill-switches do projeto.
 *
 * Implementado à mão de propósito: o `AccountSemaphore` do repo é por-instância
 * (construído a cada operação em massa) e não serve para um recurso global, e o
 * projeto evita dependência nova quando o código à mão é trivial.
 */

export type RembgLane = "internal" | "public";

export interface RembgGateSlot {
  /** Devolve o slot. Idempotente — seguro chamar em `finally`. */
  release(): void;
}

export const DEFAULT_MAX_CONCURRENCY = 2;
export const DEFAULT_PUBLIC_MAX_CONCURRENCY = 1;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isGateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.REMBG_GATE_DISABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

const NOOP_SLOT: RembgGateSlot = { release() {} };

interface Waiter {
  lane: RembgLane;
  admit: () => void;
  giveUp: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

class RembgGate {
  private inFlight = 0;
  private publicInFlight = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly capacity: number,
    private readonly publicCapacity: number,
  ) {}

  private canAdmit(lane: RembgLane): boolean {
    if (this.inFlight >= this.capacity) return false;
    if (lane === "public" && this.publicInFlight >= this.publicCapacity) {
      return false;
    }
    return true;
  }

  private take(lane: RembgLane): RembgGateSlot {
    this.inFlight += 1;
    if (lane === "public") this.publicInFlight += 1;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
        if (lane === "public") this.publicInFlight -= 1;
        this.pump();
      },
    };
  }

  /**
   * Acorda o primeiro waiter ADMISSÍVEL da fila. Varremos em vez de olhar só o
   * head para não sofrer head-of-line blocking: um waiter `public` barrado pela
   * reserva não pode segurar um `internal` que está atrás dele.
   */
  private pump(): void {
    while (this.inFlight < this.capacity) {
      const index = this.waiters.findIndex((w) => this.canAdmit(w.lane));
      if (index === -1) return;
      const [waiter] = this.waiters.splice(index, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.settled = true;
      waiter.admit();
    }
  }

  /** Snapshot para diagnóstico (GET /internal/rembg/status). Só leitura. */
  stats(): {
    inFlight: number;
    publicInFlight: number;
    waiting: number;
    capacity: number;
    publicCapacity: number;
  } {
    return {
      inFlight: this.inFlight,
      publicInFlight: this.publicInFlight,
      waiting: this.waiters.length,
      capacity: this.capacity,
      publicCapacity: this.publicCapacity,
    };
  }

  acquire(lane: RembgLane, maxWaitMs: number): Promise<RembgGateSlot | null> {
    if (this.canAdmit(lane)) {
      return Promise.resolve(this.take(lane));
    }
    if (maxWaitMs <= 0) return Promise.resolve(null);

    return new Promise<RembgGateSlot | null>((resolve) => {
      const waiter: Waiter = {
        lane,
        settled: false,
        timer: null,
        admit: () => resolve(this.take(lane)),
        giveUp: () => resolve(null),
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        waiter.giveUp();
      }, maxWaitMs);
      // `unref` para um waiter pendente não segurar o event loop por até ~40s
      // num `pm2 restart`/SIGTERM. A promise ainda resolve normalmente enquanto
      // o processo estiver vivo — só deixa de ser motivo para mantê-lo vivo.
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

}

let gate: RembgGate | null = null;

function getGate(): RembgGate {
  if (gate === null) {
    const capacity = readPositiveInt(
      process.env.REMBG_MAX_CONCURRENCY,
      DEFAULT_MAX_CONCURRENCY,
    );
    const publicCapacity = Math.min(
      capacity,
      readPositiveInt(
        process.env.REMBG_PUBLIC_MAX_CONCURRENCY,
        DEFAULT_PUBLIC_MAX_CONCURRENCY,
      ),
    );
    gate = new RembgGate(capacity, publicCapacity);
  }
  return gate;
}

/**
 * Descarta o gate (e sua contagem) para que a próxima chamada releia o env.
 * Necessário no `beforeEach` dos testes: sem isso, o estado vaza entre casos e
 * eles passam isolados mas quebram na ordem da suíte.
 */
export function __resetRembgGate(): void {
  gate = null;
}

/**
 * Pede um slot para chamar o sidecar.
 *
 * @param lane   `"internal"` (modal) tem prioridade; `"public"` (Desmont Hub)
 *               fica limitada à cota reservada.
 * @param maxWaitMs  Quanto ainda dá para esperar dentro do orçamento da
 *                   requisição. `<= 0` desiste imediatamente.
 * @returns o slot, ou `null` quando não deu para entrar a tempo — nesse caso o
 *          chamador deve degradar (nunca chamar o sidecar mesmo assim).
 */
export async function acquireRembgSlot(
  lane: RembgLane,
  maxWaitMs: number,
): Promise<RembgGateSlot | null> {
  if (isGateDisabled()) return NOOP_SLOT;
  return getGate().acquire(lane, maxWaitMs);
}

export interface RembgGateStats {
  disabled: boolean;
  inFlight: number;
  publicInFlight: number;
  waiting: number;
  capacity: number;
  publicCapacity: number;
}

/**
 * Snapshot do gate para o endpoint de diagnóstico. Aditivo e só-leitura;
 * instancia o singleton se ainda não existir (inócuo — contadores zerados).
 */
export function getRembgGateStats(): RembgGateStats {
  return { disabled: isGateDisabled(), ...getGate().stats() };
}
