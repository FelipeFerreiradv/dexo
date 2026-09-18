/**
 * `NfeSequenceService` (V1) em memória, sobre a tabela `nfeSequence` do
 * in-memory-prisma.
 *
 * Por que não rodar o serviço real: ele reserva por SQL cru com
 * `SELECT … FOR UPDATE` + `ON CONFLICT … RETURNING` (nfe-sequence.service.ts),
 * que não existe em memória. A semântica real de lock é provada na suíte PG
 * opt-in; aqui reproduzimos o CONTRATO público:
 *  - sem `opts`: contador por (userId, ambiente, série, modelo) — caminho legado;
 *  - com `opts`: contador por emitente, prefere a linha do configId e só ADOTA a
 *    linha legada (configId NULL) quando `isDefaultConfig`;
 *  - primeira reserva cria a linha com proximoNumero=2 e devolve 1;
 *  - `consultarProximoNumero` não trava nem escreve; `ajustarProximoNumero` só avança.
 *
 * `FOR UPDATE` é modelado por um mutex assíncrono por (userId, ambiente, série,
 * modelo): leitura e incremento acontecem dentro da mesma seção crítica.
 *
 * Arquivo de TESTE, sem `vi.mock`. O `import type` do serviço real é apagado
 * na compilação (não carrega o módulo que os specs mockam).
 */

import type { SequenceEmitterOpts } from "../../../app/fiscal/sequence/nfe-sequence.service";
import type { FiscalAmbiente } from "../../../app/fiscal/domain/nfe.types";
import type { InMemoryDb, Linha } from "./in-memory-prisma";

/** Mutex assíncrono por chave (cadeia de promessas). */
export class MutexPorChave {
  private caudas = new Map<string, Promise<unknown>>();

  async executar<T>(chave: string, fn: () => Promise<T>): Promise<T> {
    const anterior = this.caudas.get(chave) ?? Promise.resolve();
    let liberar!: () => void;
    const minha = new Promise<void>((r) => (liberar = r));
    const cauda = anterior.then(() => minha);
    this.caudas.set(chave, cauda);
    await anterior;
    try {
      return await fn();
    } finally {
      liberar();
      if (this.caudas.get(chave) === cauda) this.caudas.delete(chave);
    }
  }

  ocupadas(): string[] {
    return [...this.caudas.keys()];
  }
}

export interface ReservaRegistrada {
  seq: number;
  userId: string;
  ambiente: string;
  serie: number;
  modelo: "55" | "65";
  companyFiscalConfigId: string | null;
  numero: number;
  origem: "CONTADOR" | "CRIADO";
}

export interface NumeracaoMemoria {
  reservarProximoNumero(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    modelo?: "55" | "65",
    opts?: SequenceEmitterOpts,
  ): Promise<number>;
  consultarProximoNumero(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    modelo?: "55" | "65",
    opts?: SequenceEmitterOpts,
  ): Promise<number>;
  ajustarProximoNumero(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    novoNumero: number,
    modelo?: "55" | "65",
    opts?: SequenceEmitterOpts,
  ): Promise<void>;
  /** Reservas feitas (ordem de conclusão). */
  reservas(): ReservaRegistrada[];
  /** Chamadas recebidas, com os argumentos exatos (para asserções de contrato V1). */
  chamadas(): Array<{ metodo: string; args: unknown[] }>;
  reset(): void;
  readonly mutex: MutexPorChave;
}

export function createNumeracaoMemory(db: InMemoryDb): NumeracaoMemoria {
  let mutex = new MutexPorChave();
  let registro: ReservaRegistrada[] = [];
  let chamadas: Array<{ metodo: string; args: unknown[] }> = [];
  let seq = 0;

  const seqDb = () => db.client.nfeSequence;

  function validar(userId: string, serie: number, opts?: SequenceEmitterOpts): void {
    // Mesmas guardas e mensagens do serviço real.
    if (!userId) throw new Error("userId é obrigatório");
    if (serie < 0 || !Number.isInteger(serie))
      throw new Error("Série deve ser um inteiro não-negativo");
    if (opts && !opts.companyFiscalConfigId)
      throw new Error("companyFiscalConfigId é obrigatório quando informado");
  }

  function whereEmitente(
    userId: string,
    ambiente: string,
    serie: number,
    modelo: "55" | "65",
    opts?: SequenceEmitterOpts,
  ): Record<string, unknown> {
    const base = { userId, ambiente, serie, modelo };
    if (!opts) return base;
    return {
      ...base,
      OR: [
        { companyFiscalConfigId: opts.companyFiscalConfigId },
        ...(opts.isDefaultConfig ? [{ companyFiscalConfigId: null }] : []),
      ],
    };
  }

  const servico: NumeracaoMemoria = {
    get mutex() {
      return mutex;
    },

    async reservarProximoNumero(userId, ambiente, serie, modelo = "55", opts) {
      chamadas.push({ metodo: "reservarProximoNumero", args: [userId, ambiente, serie, modelo, opts] });
      validar(userId, serie, opts);
      const chaveLock = `${userId}|${ambiente}|${serie}|${modelo}`;
      return mutex.executar(chaveLock, async () => {
        // Sem opts o SELECT legado não filtra emitente; com opts, a linha do
        // próprio emitente vem antes da legada NULL (ORDER BY configId IS NULL).
        const linhas: Linha[] = await seqDb().findMany({
          where: whereEmitente(userId, ambiente, serie, modelo, opts),
        });
        const escolhida = opts
          ? ([...linhas].sort(
              (a, b) =>
                Number(a.companyFiscalConfigId == null) - Number(b.companyFiscalConfigId == null),
            )[0] ?? null)
          : (linhas[0] ?? null);

        if (escolhida) {
          const numero = Number(escolhida.proximoNumero);
          await seqDb().update({
            where: { id: escolhida.id },
            data: {
              proximoNumero: numero + 1,
              ...(opts ? { companyFiscalConfigId: opts.companyFiscalConfigId } : {}),
            },
          });
          registro.push({
            seq: ++seq,
            userId,
            ambiente,
            serie,
            modelo,
            companyFiscalConfigId: opts?.companyFiscalConfigId ?? null,
            numero,
            origem: "CONTADOR",
          });
          return numero;
        }

        await seqDb().create({
          data: {
            userId,
            ambiente,
            serie,
            modelo,
            proximoNumero: 2,
            companyFiscalConfigId: opts?.companyFiscalConfigId ?? null,
          },
        });
        registro.push({
          seq: ++seq,
          userId,
          ambiente,
          serie,
          modelo,
          companyFiscalConfigId: opts?.companyFiscalConfigId ?? null,
          numero: 1,
          origem: "CRIADO",
        });
        return 1;
      });
    },

    async consultarProximoNumero(userId, ambiente, serie, modelo = "55", opts) {
      chamadas.push({ metodo: "consultarProximoNumero", args: [userId, ambiente, serie, modelo, opts] });
      const row = await seqDb().findFirst({
        where: whereEmitente(userId, ambiente, serie, modelo, opts),
        select: { proximoNumero: true },
        orderBy: { companyFiscalConfigId: "asc" },
      });
      return row?.proximoNumero ?? 1;
    },

    async ajustarProximoNumero(userId, ambiente, serie, novoNumero, modelo = "55", opts) {
      chamadas.push({
        metodo: "ajustarProximoNumero",
        args: [userId, ambiente, serie, novoNumero, modelo, opts],
      });
      if (novoNumero < 1 || !Number.isInteger(novoNumero))
        throw new Error("Número deve ser um inteiro positivo");
      const chaveLock = `${userId}|${ambiente}|${serie}|${modelo}`;
      await mutex.executar(chaveLock, async () => {
        const existing = await seqDb().findFirst({
          where: whereEmitente(userId, ambiente, serie, modelo, opts),
          select: { id: true, proximoNumero: true },
          orderBy: { companyFiscalConfigId: "asc" },
        });
        const atual = existing?.proximoNumero ?? 1;
        if (novoNumero <= atual) {
          throw new Error(
            `Novo número (${novoNumero}) deve ser maior que o atual (${atual})`,
          );
        }
        const extra = opts ? { companyFiscalConfigId: opts.companyFiscalConfigId } : {};
        if (existing) {
          await seqDb().update({
            where: { id: existing.id },
            data: { proximoNumero: novoNumero, ...extra },
          });
          return;
        }
        await seqDb().create({
          data: { userId, ambiente, serie, modelo, proximoNumero: novoNumero, ...extra },
        });
      });
    },

    reservas() {
      return registro.map((r) => ({ ...r }));
    },

    chamadas() {
      return chamadas.map((c) => ({ metodo: c.metodo, args: [...c.args] }));
    },

    reset() {
      mutex = new MutexPorChave();
      registro = [];
      chamadas = [];
      seq = 0;
    },
  };

  return servico;
}
