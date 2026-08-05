/**
 * Agendador de escrita com debounce, isolado do React para ser testável com
 * fake timers.
 *
 * O autosave do rascunho não pode escrever a cada tecla: `JSON.stringify` de um
 * formulário de 49 campos com ficha técnica e compatibilidades a cada
 * `onChange` é desperdício puro e, em `localStorage` (que é síncrono), trava a
 * thread de UI. Com 600 ms, uma rajada de digitação vira UMA escrita.
 *
 * `flush()` existe para o caminho de fechamento do modal: se o usuário fecha
 * antes do timer disparar, a última versão ainda é gravada.
 */
export interface DebouncedWriter<T> {
  schedule: (value: T) => void;
  flush: () => void;
  cancel: () => void;
  /** Só para teste/observabilidade: quantas escritas de fato aconteceram. */
  writes: () => number;
}

export function createDebouncedWriter<T>(
  write: (value: T) => void,
  delayMs: number,
): DebouncedWriter<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  let writeCount = 0;

  const commit = () => {
    if (!pending) return;
    const { value } = pending;
    pending = null;
    writeCount++;
    write(value);
  };

  return {
    schedule(value: T) {
      pending = { value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        commit();
      }, delayMs);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      commit();
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
    writes: () => writeCount,
  };
}
