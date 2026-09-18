/**
 * `INfeProvider` roteirizado para o harness de emissão.
 *
 * Cada operação (emitir, consultar, consultarRecibo, buscarXml, cancelar,
 * inutilizar) consome uma FILA de passos. Um passo é uma função que recebe o
 * contexto da chamada e devolve o resultado (ou lança). Fila vazia sem passo
 * padrão LANÇA — chamada inesperada ao provedor é falha do teste, nunca silêncio.
 * Todas as chamadas ficam registradas em `chamadas` (ordem global).
 *
 * `passos` traz construtores prontos com o formato EXATO que os providers reais
 * devolvem hoje (sefaz-direct.provider.ts / focus-nfe.provider.ts). Os passos
 * `autorizar`/`denegar` aceitam uma `FakeAuthority`, que decide 100/204/539/206
 * como a SEFAZ decidiria.
 *
 * Arquivo de TESTE, sem `vi.mock`.
 */

import type {
  INfeProvider,
  NfeProviderCancelInput,
  NfeProviderCancelResult,
  NfeProviderConsultaResult,
  NfeProviderEmitInput,
  NfeProviderEmitResult,
  NfeProviderInutilizacaoInput,
  NfeProviderInutilizacaoResult,
} from "../../../app/fiscal/providers/nfe-provider.interface";
import type { AmbienteFiscal, ModeloFiscal } from "../../../app/fiscal/numeracao/tipos";
import {
  identidadeDoPayload,
  type FakeAuthority,
  type RespostaAutoridade,
} from "./fake-authority";

export type OperacaoProvider =
  | "emitir"
  | "consultar"
  | "consultarRecibo"
  | "buscarXml"
  | "cancelar"
  | "inutilizar";

export interface ChamadaProvider {
  seq: number;
  op: OperacaoProvider;
  args: unknown[];
}

export interface ContextoPasso {
  op: OperacaoProvider;
  args: unknown[];
  /** 1-based, por operação. */
  chamada: number;
  provider: ScriptedProvider;
}

export type Passo<R = unknown> = (ctx: ContextoPasso) => R | Promise<R>;

export type RoteiroProvider = Partial<Record<OperacaoProvider, Passo[]>>;

export interface OpcoesScriptedProvider {
  name?: "SEFAZ_DIRECT" | "FOCUS_NFE" | string;
  /** Passo usado quando a fila da operação está vazia (default: lança). */
  padrao?: Partial<Record<OperacaoProvider, Passo>>;
}

export interface ScriptedProvider extends INfeProvider {
  readonly chamadas: ChamadaProvider[];
  /** Enfileira passos para a operação. Encadeável. */
  fila(op: OperacaoProvider, ...passos: Passo[]): ScriptedProvider;
  pendentes(op?: OperacaoProvider): number;
  /** Operações chamadas, em ordem (atalho para asserções). */
  ops(): OperacaoProvider[];
  limpar(): void;
  buscarXml(ref: string, token: string): Promise<string | null>;
  consultarRecibo(nRec: string, chaveAcesso: string): Promise<NfeProviderConsultaResult>;
}

export function createScriptedProvider(
  roteiro: RoteiroProvider = {},
  opcoes: OpcoesScriptedProvider = {},
): ScriptedProvider {
  const filas = new Map<OperacaoProvider, Passo[]>();
  const contagem = new Map<OperacaoProvider, number>();
  const chamadas: ChamadaProvider[] = [];
  let seq = 0;

  for (const [op, passos] of Object.entries(roteiro) as Array<[OperacaoProvider, Passo[]]>) {
    filas.set(op, [...passos]);
  }

  async function executar<R>(op: OperacaoProvider, args: unknown[]): Promise<R> {
    chamadas.push({ seq: ++seq, op, args });
    const n = (contagem.get(op) ?? 0) + 1;
    contagem.set(op, n);
    const fila = filas.get(op) ?? [];
    const passo = fila.shift() ?? opcoes.padrao?.[op];
    if (!passo) {
      throw new Error(
        `scripted-provider: nenhum passo roteirizado para ${op} (chamada #${n}). Enfileire com provider.fila("${op}", ...).`,
      );
    }
    return (await passo({ op, args, chamada: n, provider })) as R;
  }

  const provider: ScriptedProvider = {
    name: opcoes.name ?? "SEFAZ_DIRECT",
    chamadas,
    fila(op, ...passos) {
      filas.set(op, [...(filas.get(op) ?? []), ...passos]);
      return provider;
    },
    pendentes(op) {
      if (op) return filas.get(op)?.length ?? 0;
      return [...filas.values()].reduce((acc, f) => acc + f.length, 0);
    },
    ops() {
      return chamadas.map((c) => c.op);
    },
    limpar() {
      filas.clear();
      contagem.clear();
      chamadas.length = 0;
      seq = 0;
    },
    emitir: (input: NfeProviderEmitInput) =>
      executar<NfeProviderEmitResult>("emitir", [input]),
    consultar: (ref: string, token: string) =>
      executar<NfeProviderConsultaResult>("consultar", [ref, token]),
    consultarRecibo: (nRec: string, chaveAcesso: string) =>
      executar<NfeProviderConsultaResult>("consultarRecibo", [nRec, chaveAcesso]),
    buscarXml: (ref: string, token: string) =>
      executar<string | null>("buscarXml", [ref, token]),
    cancelar: (input: NfeProviderCancelInput) =>
      executar<NfeProviderCancelResult>("cancelar", [input]),
    inutilizar: (input: NfeProviderInutilizacaoInput) =>
      executar<NfeProviderInutilizacaoResult>("inutilizar", [input]),
  };
  return provider;
}

// ───────────────────────────── Passos prontos ─────────────────────────────

export interface OpcoesAutoridadePasso {
  autoridade?: FakeAuthority;
  /** Ambiente/modelo quando o payload é JSON Focus (não carrega esses dados). */
  ambiente?: AmbienteFiscal;
  modelo?: ModeloFiscal;
}

function entradaEmissao(ctx: ContextoPasso): NfeProviderEmitInput {
  return ctx.args[0] as NfeProviderEmitInput;
}

function chaveDaEmissao(
  ctx: ContextoPasso,
  opts: OpcoesAutoridadePasso & { chave?: string | null },
): string | null {
  if (opts.chave !== undefined) return opts.chave;
  if (!opts.autoridade) return null;
  const input = entradaEmissao(ctx);
  return opts.autoridade.montarChave(
    identidadeDoPayload(input.nfeData, { ambiente: opts.ambiente, modelo: opts.modelo }),
  );
}

/** Formato que o SefazDirectProvider devolve quando a autoridade recusa. */
function resultadoRecusa(r: RespostaAutoridade, ref: string, chave: string | null): NfeProviderEmitResult {
  const duplicidade = r.cStat === 204 || r.cStat === 539 || r.cStat === 218;
  return {
    success: false,
    chaveAcesso: chave,
    protocolo: null,
    dataAutorizacao: null,
    status: duplicidade ? "processando" : "rejeitada",
    codigoStatus: r.cStat,
    mensagem: duplicidade
      ? `Duplicidade (cStat ${r.cStat}) — reconciliar por consulta: ${r.xMotivo}`
      : r.xMotivo,
    xmlAutorizado: null,
    providerRef: ref,
  };
}

export const passos = {
  /**
   * emitir → autorizada (formato SEFAZ direto síncrono: 104 + protNFe 100).
   * Com `autoridade`, grava a autorização (ou devolve 204/539/206 como a SEFAZ).
   */
  autorizar(
    opts: OpcoesAutoridadePasso & {
      chave?: string;
      protocolo?: string;
      xml?: string | null;
      dataAutorizacao?: Date;
      mensagem?: string;
    } = {},
  ): Passo<NfeProviderEmitResult> {
    return (ctx) => {
      const input = entradaEmissao(ctx);
      let chave = chaveDaEmissao(ctx, opts);
      let protocolo = opts.protocolo ?? "135260000000999";
      if (opts.autoridade) {
        const id = identidadeDoPayload(input.nfeData, { ambiente: opts.ambiente, modelo: opts.modelo });
        const r = opts.autoridade.autorizar(id, { chave: chave ?? undefined, nfeId: input.ref });
        if (r.cStat !== 100) return resultadoRecusa(r, input.ref, chave);
        chave = r.chave;
        protocolo = opts.protocolo ?? r.protocolo ?? protocolo;
      }
      if (!chave) {
        throw new Error("passos.autorizar: informe `chave` ou `autoridade` para gerar a chave de acesso");
      }
      return {
        success: true,
        chaveAcesso: chave,
        protocolo,
        dataAutorizacao: opts.dataAutorizacao ?? new Date("2026-09-17T13:00:00.000Z"),
        status: "autorizada",
        codigoStatus: 100,
        mensagem: opts.mensagem ?? "Autorizado o uso da NF-e",
        xmlAutorizado:
          opts.xml === undefined
            ? `<nfeProc versao="4.00"><!-- harness --><chNFe>${chave}</chNFe><nProt>${protocolo}</nProt></nfeProc>`
            : opts.xml,
        providerRef: input.ref,
      };
    };
  },

  /** emitir → rejeitada com cStat (número OU string, como o Focus devolve). */
  rejeitar(
    cStat: number | string,
    mensagem = `Rejeicao: cStat ${cStat}`,
    opts: OpcoesAutoridadePasso & { chave?: string | null } = {},
  ): Passo<NfeProviderEmitResult> {
    return (ctx) => ({
      success: false,
      chaveAcesso: chaveDaEmissao(ctx, opts),
      protocolo: null,
      dataAutorizacao: null,
      status: "rejeitada",
      codigoStatus: cStat as unknown as number,
      mensagem,
      xmlAutorizado: null,
      providerRef: entradaEmissao(ctx).ref,
    });
  },

  /** emitir → denegada (110). Com `autoridade`, o número fica consumido. */
  denegar(opts: OpcoesAutoridadePasso & { chave?: string } = {}): Passo<NfeProviderEmitResult> {
    return (ctx) => {
      const input = entradaEmissao(ctx);
      let chave = chaveDaEmissao(ctx, opts);
      if (opts.autoridade) {
        const id = identidadeDoPayload(input.nfeData, { ambiente: opts.ambiente, modelo: opts.modelo });
        const r = opts.autoridade.denegar(id, { chave: chave ?? undefined, nfeId: input.ref });
        if (r.cStat !== 110) return resultadoRecusa(r, input.ref, chave);
        chave = r.chave;
      }
      return {
        success: false,
        chaveAcesso: chave,
        protocolo: null,
        dataAutorizacao: null,
        status: "rejeitada",
        codigoStatus: 110,
        mensagem: "Uso Denegado",
        xmlAutorizado: null,
        providerRef: input.ref,
      };
    };
  },

  /** emitir → processando (103 assíncrono com nRec, ou 202 do Focus). */
  processando(
    opts: OpcoesAutoridadePasso & { cStat?: number | null; protocolo?: string | null; chave?: string | null; mensagem?: string } = {},
  ): Passo<NfeProviderEmitResult> {
    return (ctx) => ({
      success: true,
      chaveAcesso: chaveDaEmissao(ctx, opts),
      protocolo: opts.protocolo ?? null,
      dataAutorizacao: null,
      status: "processando",
      codigoStatus: (opts.cStat ?? null) as number | null,
      mensagem: opts.mensagem ?? "Lote recebido — consultar via nRec",
      xmlAutorizado: null,
      providerRef: entradaEmissao(ctx).ref,
    });
  },

  /**
   * emitir → erro (falha pré-envio montada pelo provider, rede, HTTP ≥ 400).
   * Formato de `makeEmitErrorResult` do sefaz-direct.provider.ts.
   */
  erro(mensagem: string, opts: OpcoesAutoridadePasso & { chave?: string | null } = {}): Passo<NfeProviderEmitResult> {
    return (ctx) => ({
      success: false,
      chaveAcesso: chaveDaEmissao(ctx, opts),
      protocolo: null,
      dataAutorizacao: null,
      status: "erro",
      codigoStatus: null,
      mensagem,
      xmlAutorizado: null,
      providerRef: entradaEmissao(ctx).ref,
    });
  },

  /** Qualquer operação → lança. */
  lancar(erro: Error): Passo<never> {
    return () => {
      throw erro;
    };
  },

  /**
   * Segura a chamada até `liberar(passo)` — para cenários de requisição em voo.
   * `chegou` resolve quando o provider foi efetivamente chamado.
   */
  segurar<R = unknown>(): { passo: Passo<R>; chegou: Promise<ContextoPasso>; liberar: (p: Passo<R>) => void } {
    let resolverChegada!: (c: ContextoPasso) => void;
    let resolverLiberacao!: (p: Passo<R>) => void;
    const chegou = new Promise<ContextoPasso>((r) => (resolverChegada = r));
    const liberado = new Promise<Passo<R>>((r) => (resolverLiberacao = r));
    return {
      chegou,
      liberar: (p) => resolverLiberacao(p),
      passo: async (ctx) => {
        resolverChegada(ctx);
        const p = await liberado;
        return p(ctx);
      },
    };
  },

  // ── consultar / consultarRecibo ──

  consultaAutorizada(
    opts: { chave?: string | null; protocolo?: string; xml?: string | null; autoridade?: FakeAuthority } = {},
  ): Passo<NfeProviderConsultaResult> {
    return (ctx) => {
      const chaveArg = ctx.op === "consultarRecibo" ? String(ctx.args[1] ?? "") : String(ctx.args[0] ?? "");
      const chave = opts.chave !== undefined ? opts.chave : chaveArg || null;
      const reg = opts.autoridade && chave ? opts.autoridade.consultarPorChave(chave) : null;
      if (reg && reg.cStat !== 100) {
        return {
          status: reg.cStat === 101 ? "cancelada" : "rejeitada",
          chaveAcesso: chave,
          protocolo: reg.protocolo,
          dataAutorizacao: null,
          codigoStatus: reg.cStat,
          mensagem: reg.xMotivo,
          xmlAutorizado: null,
        };
      }
      return {
        status: "autorizada",
        chaveAcesso: chave,
        protocolo: opts.protocolo ?? reg?.protocolo ?? "135260000000999",
        dataAutorizacao: new Date("2026-09-17T13:00:00.000Z"),
        codigoStatus: 100,
        mensagem: "Autorizado o uso da NF-e",
        xmlAutorizado: opts.xml ?? null,
      };
    };
  },

  consultaRejeitada(cStat: number | string, mensagem = `Rejeicao: cStat ${cStat}`): Passo<NfeProviderConsultaResult> {
    return () => ({
      status: "rejeitada",
      chaveAcesso: null,
      protocolo: null,
      dataAutorizacao: null,
      codigoStatus: cStat as unknown as number,
      mensagem,
      xmlAutorizado: null,
    });
  },

  consultaNaoConsta(): Passo<NfeProviderConsultaResult> {
    return passos.consultaRejeitada(217, "Rejeicao: NF-e nao consta na base de dados da SEFAZ");
  },

  consultaProcessando(mensagem = "Processando"): Passo<NfeProviderConsultaResult> {
    return () => ({
      status: "processando",
      chaveAcesso: null,
      protocolo: null,
      dataAutorizacao: null,
      codigoStatus: null,
      mensagem,
      xmlAutorizado: null,
    });
  },

  consultaErro(mensagem = "Erro de rede ao consultar NFe"): Passo<NfeProviderConsultaResult> {
    return () => ({
      status: "erro",
      chaveAcesso: null,
      protocolo: null,
      dataAutorizacao: null,
      codigoStatus: null,
      mensagem,
      xmlAutorizado: null,
    });
  },

  // ── buscarXml / cancelar / inutilizar ──

  xml(conteudo: string | null): Passo<string | null> {
    return () => conteudo;
  },

  cancelamento(success: boolean, mensagem = success ? "Evento registrado e vinculado a NF-e" : "Rejeicao"): Passo<NfeProviderCancelResult> {
    return () => ({ success, protocolo: success ? "135260000000555" : null, mensagem });
  },

  inutilizacao(success: boolean, mensagem = success ? "Inutilizacao de numero homologado" : "Rejeicao"): Passo<NfeProviderInutilizacaoResult> {
    return () => ({ success, protocolo: success ? "135260000000777" : null, mensagem });
  },
};
