import type {
  INfeProvider,
  NfeProviderEmitInput,
  NfeProviderEmitResult,
  NfeProviderConsultaResult,
  NfeProviderCancelInput,
  NfeProviderCancelResult,
  NfeProviderInutilizacaoInput,
  NfeProviderInutilizacaoResult,
} from "../../../app/fiscal/providers/nfe-provider.interface";

type Call<TInput> = { input: TInput; at: Date };

/**
 * In-memory provider used by tests. Supports queued responses per method so a
 * single test can simulate sequences like "first emit returns processando,
 * follow-up consulta returns autorizada".
 *
 * If a queue is empty, the provider falls back to a sensible default (success
 * for emit/consulta/cancel/inutiliza). Default outputs use stable values so
 * tests can assert against them without per-test fixtures.
 */
export class MockNfeProvider implements INfeProvider {
  readonly name = "MOCK";

  private emitQueue: Array<NfeProviderEmitResult | Error> = [];
  private consultaQueue: Array<NfeProviderConsultaResult | Error> = [];
  private cancelQueue: Array<NfeProviderCancelResult | Error> = [];
  private inutilizaQueue: Array<NfeProviderInutilizacaoResult | Error> = [];

  readonly emitCalls: Array<Call<NfeProviderEmitInput>> = [];
  readonly consultaCalls: Array<Call<{ ref: string; token: string }>> = [];
  readonly cancelCalls: Array<Call<NfeProviderCancelInput>> = [];
  readonly inutilizaCalls: Array<Call<NfeProviderInutilizacaoInput>> = [];

  queueEmit(result: NfeProviderEmitResult | Error): this {
    this.emitQueue.push(result);
    return this;
  }

  queueConsulta(result: NfeProviderConsultaResult | Error): this {
    this.consultaQueue.push(result);
    return this;
  }

  queueCancel(result: NfeProviderCancelResult | Error): this {
    this.cancelQueue.push(result);
    return this;
  }

  queueInutiliza(result: NfeProviderInutilizacaoResult | Error): this {
    this.inutilizaQueue.push(result);
    return this;
  }

  reset(): void {
    this.emitQueue.length = 0;
    this.consultaQueue.length = 0;
    this.cancelQueue.length = 0;
    this.inutilizaQueue.length = 0;
    this.emitCalls.length = 0;
    this.consultaCalls.length = 0;
    this.cancelCalls.length = 0;
    this.inutilizaCalls.length = 0;
  }

  async emitir(input: NfeProviderEmitInput): Promise<NfeProviderEmitResult> {
    this.emitCalls.push({ input, at: new Date() });
    const next = this.emitQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? defaultEmitAutorizada(input);
  }

  async consultar(
    ref: string,
    token: string,
  ): Promise<NfeProviderConsultaResult> {
    this.consultaCalls.push({ input: { ref, token }, at: new Date() });
    const next = this.consultaQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? defaultConsultaAutorizada(ref);
  }

  async cancelar(
    input: NfeProviderCancelInput,
  ): Promise<NfeProviderCancelResult> {
    this.cancelCalls.push({ input, at: new Date() });
    const next = this.cancelQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? defaultCancelSuccess();
  }

  async inutilizar(
    input: NfeProviderInutilizacaoInput,
  ): Promise<NfeProviderInutilizacaoResult> {
    this.inutilizaCalls.push({ input, at: new Date() });
    const next = this.inutilizaQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? defaultInutilizaSuccess();
  }
}

function defaultEmitAutorizada(
  input: NfeProviderEmitInput,
): NfeProviderEmitResult {
  return {
    success: true,
    chaveAcesso: "35260400000000000100550010000000011000000017",
    protocolo: "135260000000001",
    dataAutorizacao: new Date("2026-05-14T12:00:00Z"),
    status: "autorizada",
    codigoStatus: 100,
    mensagem: "Autorizado o uso da NF-e",
    xmlAutorizado: null,
    providerRef: input.ref,
  };
}

function defaultConsultaAutorizada(ref: string): NfeProviderConsultaResult {
  void ref;
  return {
    status: "autorizada",
    chaveAcesso: "35260400000000000100550010000000011000000017",
    protocolo: "135260000000001",
    dataAutorizacao: new Date("2026-05-14T12:00:00Z"),
    codigoStatus: 100,
    mensagem: "Autorizado o uso da NF-e",
    xmlAutorizado: null,
  };
}

function defaultCancelSuccess(): NfeProviderCancelResult {
  return {
    success: true,
    protocolo: "135260000000002",
    mensagem: "Evento registrado e vinculado a NF-e",
  };
}

function defaultInutilizaSuccess(): NfeProviderInutilizacaoResult {
  return {
    success: true,
    protocolo: "135260000000003",
    mensagem: "Inutilizacao homologada",
  };
}

/**
 * Builder helpers for the most common result shapes — keep tests readable.
 */
export const NfeProviderResults = {
  emitAutorizada: (
    overrides?: Partial<NfeProviderEmitResult>,
  ): NfeProviderEmitResult => ({
    ...defaultEmitAutorizada({
      nfeData: {},
      token: "",
      ref: "ref-mock",
    }),
    ...overrides,
  }),
  emitProcessando: (
    overrides?: Partial<NfeProviderEmitResult>,
  ): NfeProviderEmitResult => ({
    success: true,
    chaveAcesso: null,
    protocolo: null,
    dataAutorizacao: null,
    status: "processando",
    codigoStatus: 103,
    mensagem: "Lote recebido com sucesso",
    xmlAutorizado: null,
    providerRef: "ref-mock",
    ...overrides,
  }),
  emitRejeitada: (
    overrides?: Partial<NfeProviderEmitResult>,
  ): NfeProviderEmitResult => ({
    success: false,
    chaveAcesso: null,
    protocolo: null,
    dataAutorizacao: null,
    status: "rejeitada",
    codigoStatus: 539,
    mensagem: "Rejeicao: NF-e ja autorizada",
    xmlAutorizado: null,
    providerRef: null,
    ...overrides,
  }),
  emitErro: (
    overrides?: Partial<NfeProviderEmitResult>,
  ): NfeProviderEmitResult => ({
    success: false,
    chaveAcesso: null,
    protocolo: null,
    dataAutorizacao: null,
    status: "erro",
    codigoStatus: null,
    mensagem: "Erro de conexao com SEFAZ",
    xmlAutorizado: null,
    providerRef: null,
    ...overrides,
  }),
  consultaAutorizada: defaultConsultaAutorizada,
  cancelSuccess: defaultCancelSuccess,
  inutilizaSuccess: defaultInutilizaSuccess,
};
