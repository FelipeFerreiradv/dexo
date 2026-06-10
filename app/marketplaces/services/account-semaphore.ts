/**
 * Semáforo em memória chaveado por conta de marketplace.
 *
 * `runExclusive(key, fn)`: chamadas com a mesma `key` são serializadas FIFO
 * — uma só roda por vez; chamadas com `key` diferentes rodam em paralelo.
 *
 * Uso típico: deleção em massa precisa fechar N anúncios em ML/Shopee
 * respeitando rate limit (~10 req/s por conta no ML). Serializar por
 * `marketplaceAccountId` evita o surto de chamadas paralelas que dispara
 * 429 + race no refresh de token.
 *
 * Implementação: encadeia promises em um Map<key, Promise>. Cada nova
 * chamada agenda-se depois da última. O slot é liberado quando todas
 * as chamadas em fila para aquela conta terminaram.
 */
export class AccountSemaphore {
  private readonly queues = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    // Encadeia: aguarda a anterior (ignorando rejeição para não envenenar
    // a próxima) e roda `fn`. O resultado de `fn` é o que retornamos.
    const settled = prev.then(
      () => undefined,
      () => undefined,
    );
    const run = settled.then(() => fn());

    // A "tail" da fila é a versão settled da nossa execução. Não propaga
    // throw para o próximo caller — ele só precisa saber que terminamos.
    const tail: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    tail.then(() => {
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    });

    return run;
  }
}
