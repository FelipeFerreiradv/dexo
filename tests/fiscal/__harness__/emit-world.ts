/**
 * Mundo do harness de emissão: estado + doubles + seeds + módulos prontos para
 * `vi.mock`. Singleton POR ARQUIVO DE SPEC (o vitest isola o grafo de módulos
 * por arquivo), acessado por `world()`.
 *
 * Regra de ouro deste arquivo (e de todo `__harness__`): NÃO importar em tempo
 * de execução nenhum módulo que os specs mockam (app/lib/prisma, sequence,
 * provider-factory, fiscal-storage, danfe-*, customer.*). A fábrica do
 * `vi.mock` importa este arquivo; se ele importasse o módulo mockado, o
 * carregamento ficaria circular. `import type` é apagado e pode.
 *
 * Wiring e pontos de extensão: README.md desta pasta.
 */

import { vi } from "vitest";

import type { CompanyFiscalConfig } from "../../../app/interfaces/company-fiscal.interface";
import type { NfeDraftItem } from "../../../app/interfaces/nfe.interface";
import type {
  INfeProvider,
} from "../../../app/fiscal/providers/nfe-provider.interface";
import type { AmbienteFiscal, ModeloFiscal } from "../../../app/fiscal/numeracao/tipos";
import { makeConfig, makeDraft, makeItem } from "../__helpers__/test-draft";
import {
  createInMemoryPrisma,
  type InMemoryDb,
  type InMemoryPrismaClient,
  type Linha,
  type OpcoesMemoria,
} from "./in-memory-prisma";
import { FakeAuthority, type IdentidadeFiscal } from "./fake-authority";
import { createScriptedProvider, type ScriptedProvider } from "./scripted-provider";
import { createNumeracaoMemory, type NumeracaoMemoria } from "./numeracao-memory";
import { todasViolacoes } from "./invariants";

// ───────────────────────────── Storage fake ─────────────────────────────

export type MetodoStorage =
  | "saveXmlOriginal"
  | "saveXmlAutorizado"
  | "saveDanfePdf"
  | "saveCertificate"
  | "readFile"
  | "deleteFile";

export class FakeFiscalStorage {
  readonly arquivos = new Map<string, Buffer>();
  readonly chamadas: Array<{ metodo: MetodoStorage; args: unknown[] }> = [];
  private falhas: Array<{ metodo: MetodoStorage; erro: Error }> = [];

  reset(): void {
    this.arquivos.clear();
    this.chamadas.length = 0;
    this.falhas = [];
  }

  /** A PRÓXIMA chamada de `metodo` lança `erro` (sem gravar nada). */
  failNext(metodo: MetodoStorage, erro: Error = new Error(`storage fake: falha injetada em ${metodo}`)): void {
    this.falhas.push({ metodo, erro });
  }

  lerTexto(caminho: string): string | null {
    const b = this.arquivos.get(caminho);
    return b ? b.toString("utf-8") : null;
  }

  private entrar(metodo: MetodoStorage, args: unknown[]): void {
    this.chamadas.push({ metodo, args });
    const i = this.falhas.findIndex((f) => f.metodo === metodo);
    if (i >= 0) {
      const [f] = this.falhas.splice(i, 1);
      throw f.erro;
    }
  }

  async saveXmlOriginal(userId: string, nfeId: string, xml: string): Promise<string> {
    this.entrar("saveXmlOriginal", [userId, nfeId, xml]);
    const p = `mem://fiscal/${userId}/xml-original/${nfeId}.xml`;
    this.arquivos.set(p, Buffer.from(xml, "utf-8"));
    return p;
  }

  async saveXmlAutorizado(userId: string, nfeId: string, xml: string): Promise<string> {
    this.entrar("saveXmlAutorizado", [userId, nfeId, xml]);
    const p = `mem://fiscal/${userId}/xml-autorizado/${nfeId}.xml`;
    this.arquivos.set(p, Buffer.from(xml, "utf-8"));
    return p;
  }

  async saveDanfePdf(userId: string, nfeId: string, pdfBytes: Uint8Array): Promise<string> {
    this.entrar("saveDanfePdf", [userId, nfeId, pdfBytes.byteLength]);
    const p = `mem://fiscal/${userId}/danfe/${nfeId}.pdf`;
    this.arquivos.set(p, Buffer.from(pdfBytes));
    return p;
  }

  async saveCertificate(userId: string, pfxBuffer: Buffer, configId?: string): Promise<string> {
    this.entrar("saveCertificate", [userId, pfxBuffer.byteLength, configId]);
    const p = `mem://fiscal/certs/${configId ? `${userId}-${configId}` : userId}.pfx`;
    this.arquivos.set(p, Buffer.from(pfxBuffer));
    return p;
  }

  async readFile(filePath: string): Promise<Buffer | null> {
    this.entrar("readFile", [filePath]);
    return this.arquivos.get(filePath) ?? null;
  }

  async deleteFile(filePath: string): Promise<void> {
    this.entrar("deleteFile", [filePath]);
    this.arquivos.delete(filePath);
  }
}

// ───────────────────────────── Provider factory fake ─────────────────────────────

export type FuncaoFactory =
  | "createNfeProvider"
  | "createNfeProviderFromConfig"
  | "createSefazDirectProvider";

export class FakeProviderFactory {
  readonly chamadas: Array<{ funcao: FuncaoFactory; providerName: string | null; ambiente: string; extra: unknown }> = [];
  private falhas: Error[] = [];

  constructor(private readonly obterProvider: () => INfeProvider) {}

  reset(): void {
    this.chamadas.length = 0;
    this.falhas = [];
  }

  /** A próxima construção de provider lança (ex.: certificado ilegível — R5). */
  failNext(erro: Error = new Error("Falha ao carregar certificado A1 (fake)")): void {
    this.falhas.push(erro);
  }

  private entregar(funcao: FuncaoFactory, providerName: string | null, ambiente: string, extra: unknown): INfeProvider {
    this.chamadas.push({ funcao, providerName, ambiente, extra });
    const erro = this.falhas.shift();
    if (erro) throw erro;
    return this.obterProvider();
  }

  readonly createNfeProvider = (
    providerName: string | null,
    ambiente: "HOMOLOGACAO" | "PRODUCAO",
    opts?: { modelo?: "55" | "65" },
  ): INfeProvider => this.entregar("createNfeProvider", providerName, ambiente, opts ?? null);

  readonly createNfeProviderFromConfig = async (input: {
    providerName: string | null;
    ambiente: "HOMOLOGACAO" | "PRODUCAO";
    uf?: string | null;
  }): Promise<INfeProvider> =>
    this.entregar("createNfeProviderFromConfig", input.providerName, input.ambiente, { uf: input.uf ?? null });

  readonly createSefazDirectProvider = async (input: {
    providerName: "SEFAZ_DIRECT";
    ambiente: "HOMOLOGACAO" | "PRODUCAO";
    uf: string;
  }): Promise<INfeProvider> =>
    this.entregar("createSefazDirectProvider", input.providerName, input.ambiente, { uf: input.uf });
}

// ───────────────────────────── Seeds ─────────────────────────────

export interface SeedConfigOpts extends Partial<CompanyFiscalConfig> {
  providerName?: "SEFAZ_DIRECT" | "FOCUS_NFE";
}

export interface ReferenciaConfig {
  id: string;
  userId: string;
}

export interface SeedDraftOpts {
  config: ReferenciaConfig & Partial<CompanyFiscalConfig>;
  /** Default: ambiente da config. */
  ambiente?: AmbienteFiscal;
  modelo?: ModeloFiscal;
  /** Default: config.serieNfe (55) / config.serieNfce (65) / 1. */
  serie?: number;
  itens?: Array<Partial<NfeDraftItem>>;
  /** Colunas extras/override da linha NfeEmitida (ex.: status, numero). */
  campos?: Linha;
}

export interface SeedAutorizadaOpts {
  config: ReferenciaConfig & Partial<CompanyFiscalConfig>;
  ambiente?: AmbienteFiscal;
  modelo?: ModeloFiscal;
  serie?: number;
  campos?: Linha;
}

export interface ChaveContador {
  config?: ReferenciaConfig & Partial<CompanyFiscalConfig>;
  userId?: string;
  companyFiscalConfigId?: string | null;
  ambiente?: AmbienteFiscal;
  serie?: number;
  modelo?: ModeloFiscal;
}

// ───────────────────────────── World ─────────────────────────────

export interface OpcoesReset extends OpcoesMemoria {
  /** Nome do provider roteirizado criado no reset. Default "SEFAZ_DIRECT". */
  providerName?: "SEFAZ_DIRECT" | "FOCUS_NFE";
}

const PDF_STUB = new TextEncoder().encode("%PDF-1.4\n% harness stub\n");

export class EmitWorld {
  readonly db: InMemoryDb = createInMemoryPrisma();
  readonly authority = new FakeAuthority();
  readonly storage = new FakeFiscalStorage();
  readonly numeracao: NumeracaoMemoria = createNumeracaoMemory(this.db);
  /** Provider devolvido pela factory fake. Trocável com `usarProvider`. */
  provider: ScriptedProvider = createScriptedProvider();
  readonly providerFactory = new FakeProviderFactory(() => this.provider);
  readonly danfeChamadas: Array<{ servico: string; metodo: string }> = [];
  private seqConfig = 0;

  get prisma(): InMemoryPrismaClient {
    return this.db.client;
  }

  reset(opcoes: OpcoesReset = {}): void {
    this.db.reset(opcoes);
    this.authority.reset();
    this.storage.reset();
    this.numeracao.reset();
    this.providerFactory.reset();
    this.provider = createScriptedProvider({}, { name: opcoes.providerName ?? "SEFAZ_DIRECT" });
    this.danfeChamadas.length = 0;
    this.seqConfig = 0;
  }

  usarProvider(p: ScriptedProvider): ScriptedProvider {
    this.provider = p;
    return p;
  }

  /**
   * Objetos prontos para as fábricas do `vi.mock`. Referências ESTÁVEIS: o
   * `reset()` limpa o estado por dentro, nunca troca estes objetos.
   */
  readonly modules = (() => {
    const w = { db:this.db, numeracao:this.numeracao, providerFactory:this.providerFactory, storage:this.storage, danfeChamadas:this.danfeChamadas };
    return {
      prisma: { default: w.db.client },
      sequenceV1: {
        NfeSequenceService: class {
          reservarProximoNumero = (...a: Parameters<NumeracaoMemoria["reservarProximoNumero"]>) =>
            w.numeracao.reservarProximoNumero(...a);
          consultarProximoNumero = (...a: Parameters<NumeracaoMemoria["consultarProximoNumero"]>) =>
            w.numeracao.consultarProximoNumero(...a);
          ajustarProximoNumero = (...a: Parameters<NumeracaoMemoria["ajustarProximoNumero"]>) =>
            w.numeracao.ajustarProximoNumero(...a);
        },
      },
      providerFactory: {
        createNfeProvider: w.providerFactory.createNfeProvider,
        createNfeProviderFromConfig: w.providerFactory.createNfeProviderFromConfig,
        createSefazDirectProvider: w.providerFactory.createSefazDirectProvider,
      },
      storage: {
        FiscalStorageService: class {
          saveXmlOriginal = (...a: Parameters<FakeFiscalStorage["saveXmlOriginal"]>) => w.storage.saveXmlOriginal(...a);
          saveXmlAutorizado = (...a: Parameters<FakeFiscalStorage["saveXmlAutorizado"]>) => w.storage.saveXmlAutorizado(...a);
          saveDanfePdf = (...a: Parameters<FakeFiscalStorage["saveDanfePdf"]>) => w.storage.saveDanfePdf(...a);
          saveCertificate = (...a: Parameters<FakeFiscalStorage["saveCertificate"]>) => w.storage.saveCertificate(...a);
          readFile = (...a: Parameters<FakeFiscalStorage["readFile"]>) => w.storage.readFile(...a);
          deleteFile = (...a: Parameters<FakeFiscalStorage["deleteFile"]>) => w.storage.deleteFile(...a);
        },
      },
      danfePdf: {
        DanfePdfService: class {
          async generate(): Promise<Uint8Array> {
            w.danfeChamadas.push({ servico: "DanfePdfService", metodo: "generate" });
            return PDF_STUB;
          }
          async generateFromXml(): Promise<Uint8Array> {
            w.danfeChamadas.push({ servico: "DanfePdfService", metodo: "generateFromXml" });
            return PDF_STUB;
          }
        },
        projectParsedNfeToDraft: () => {
          throw new Error("harness: projectParsedNfeToDraft está stubado (danfe-pdf.service mockado)");
        },
      },
      danfeNfcePdf: {
        DanfeNfcePdfService: class {
          async generate(): Promise<Uint8Array> {
            w.danfeChamadas.push({ servico: "DanfeNfcePdfService", metodo: "generate" });
            return PDF_STUB;
          }
          async generateFromXml(): Promise<Uint8Array> {
            w.danfeChamadas.push({ servico: "DanfeNfcePdfService", metodo: "generateFromXml" });
            return PDF_STUB;
          }
        },
      },
      customerRepository: {
        CustomerRepository: class {
          async findByCnpj(): Promise<null> {
            return null;
          }
          async findByCpf(): Promise<null> {
            return null;
          }
        },
      },
      customerUseCase: {
        CustomerUseCase: class {
          async create(): Promise<never> {
            throw new Error("harness: CustomerUseCase.create está stubado");
          }
        },
      },
    };
  })();

  // ── Seeds ──

  seedUser(id = "user-1", dados: Linha = {}): Linha {
    return this.db.inserir("user", { id, avatarUrl: null, ...dados });
  }

  /**
   * Config fiscal válida para emitir (makeConfig + colunas do schema). SEFAZ
   * direto ganha certificado fictício; Focus ganha token sentinela.
   */
  seedConfig(overrides: SeedConfigOpts = {}): CompanyFiscalConfig {
    this.seqConfig += 1;
    const providerName = overrides.providerName ?? "SEFAZ_DIRECT";
    const id = overrides.id ?? `cfg-${this.seqConfig}`;
    const base = makeConfig({
      id,
      userId: "user-1",
      providerName,
      ...(providerName === "SEFAZ_DIRECT"
        ? { certificadoPath: `mem://fiscal/certs/${id}.pfx`, certificadoSenhaEnc: "SENHA-SENTINEL" }
        : { providerToken: `TOKEN-SENTINEL-${id}` }),
      ...overrides,
    } as Partial<CompanyFiscalConfig>);
    // makeConfig faz cast: colunas do schema que ele não preenche chegam
    // undefined em runtime, por isso os `??` abaixo.
    const linha = this.db.inserir("companyFiscalConfig", {
      ...base,
      certificadoSubjectCN: base.certificadoSubjectCN ?? null,
      serieNfe: base.serieNfe ?? 1,
      serieNfce: base.serieNfce ?? 1,
      cscId: base.cscId ?? null,
      cscToken: base.cscToken ?? null,
      ncmPadrao: base.ncmPadrao ?? null,
      isDefault: overrides.isDefault ?? this.seqConfig === 1,
    });
    return linha as CompanyFiscalConfig;
  }

  /**
   * Rascunho pronto para emitir, gravado como o createDraft + updateDraft
   * reais deixariam (numero placeholder = -(DRAFTs do usuário + 1)).
   */
  seedDraft(opts: SeedDraftOpts): string {
    const { config } = opts;
    const modelo = opts.modelo ?? "55";
    const d = makeDraft();
    const drafts = this.db
      .tabela("nfeEmitida")
      .filter((l) => l.userId === config.userId && l.status === "DRAFT").length;
    const serie =
      opts.serie ?? (modelo === "65" ? (config.serieNfce ?? 1) : (config.serieNfe ?? 1));
    // Só as colunas que `buildNfeItemCreateData` (nfe.repository.ts) persiste:
    // cstIcms/aliquotas do NfeDraftItem NÃO são colunas de NfeItem.
    const itens = (opts.itens ?? [{}]).map((over, idx) => {
      const it = makeItem({ numero: idx + 1, ...over });
      return {
        productId: it.productId ?? null,
        numero: it.numero ?? idx + 1,
        codigo: it.codigo,
        descricao: it.descricao,
        ncm: it.ncm,
        cfop: it.cfop,
        cest: it.cest ?? null,
        origem: it.origem,
        unidade: it.unidade,
        quantidade: it.quantidade,
        valorUnitario: it.valorUnitario,
        valorTotal: it.valorTotal,
        desconto: it.desconto ?? null,
        observacoes: it.observacoes ?? null,
        tributosJson: it.tributosJson ?? null,
      };
    });
    const row = this.db.inserir("nfeEmitida", {
      userId: config.userId,
      companyFiscalConfigId: config.id,
      ambiente: opts.ambiente ?? config.ambiente ?? "HOMOLOGACAO",
      modelo,
      serie,
      numero: -(drafts + 1),
      tipoOperacao: d.tipoOperacao,
      finalidade: d.finalidade,
      destinoOperacao: d.destinoOperacao,
      naturezaOperacao: d.naturezaOperacao,
      indPresenca: d.indPresenca,
      destinatarioJson: d.destinatarioJson,
      modalidadeFrete: d.modalidadeFrete,
      totaisJson: d.totaisJson,
      status: "DRAFT",
      emittedByUserId: config.userId,
      ...opts.campos,
      itens: { create: itens },
    });
    return String(row.id);
  }

  /**
   * Nota AUTHORIZED já consumida na autoridade (ex.: "100 autorizada"):
   * linha com número real, chave de 44 dígitos e protocolo, e o mesmo número
   * registrado como autorizado na `FakeAuthority`.
   */
  seedAutorizada(numero: number, opts: SeedAutorizadaOpts): string {
    const { config } = opts;
    const modelo = opts.modelo ?? "55";
    const ambiente = opts.ambiente ?? config.ambiente ?? "HOMOLOGACAO";
    const serie = opts.serie ?? (modelo === "65" ? (config.serieNfce ?? 1) : (config.serieNfe ?? 1));
    const identidade: IdentidadeFiscal = {
      cnpj: String(config.cnpj ?? makeConfig().cnpj),
      ambiente,
      modelo,
      serie,
      numero,
      uf: config.uf ?? undefined,
    };
    const chave = this.authority.montarChave(identidade);
    const id = this.seedDraft({
      config,
      modelo,
      ambiente,
      serie,
      campos: {
        numero,
        status: "AUTHORIZED",
        chaveAcesso: chave,
        dataEmissao: new Date("2026-09-17T12:00:00.000Z"),
        dataAutorizacao: new Date("2026-09-17T12:00:00.000Z"),
        ...opts.campos,
      },
    });
    const r = this.authority.autorizar(identidade, { chave, nfeId: id });
    if (r.cStat !== 100) {
      throw new Error(`seedAutorizada: autoridade recusou ${numero} (cStat ${r.cStat})`);
    }
    this.db.atualizar("nfeEmitida", id, { protocoloAutorizacao: r.protocolo });
    return id;
  }

  /** Define o próximo número do contador (cria a linha se preciso). */
  setProximoNumero(proximo: number, chave: ChaveContador): void {
    const k = this.resolverContador(chave);
    const existente = this.db
      .tabela("nfeSequence")
      .find(
        (l) =>
          l.userId === k.userId &&
          l.ambiente === k.ambiente &&
          l.serie === k.serie &&
          l.modelo === k.modelo &&
          (l.companyFiscalConfigId ?? null) === k.companyFiscalConfigId,
      );
    if (existente) {
      this.db.atualizar("nfeSequence", String(existente.id), { proximoNumero: proximo });
      return;
    }
    this.db.inserir("nfeSequence", { ...k, proximoNumero: proximo });
  }

  proximoNumero(chave: ChaveContador): number | null {
    const k = this.resolverContador(chave);
    const l = this.db
      .tabela("nfeSequence")
      .find(
        (x) =>
          x.userId === k.userId &&
          x.ambiente === k.ambiente &&
          x.serie === k.serie &&
          x.modelo === k.modelo &&
          (x.companyFiscalConfigId ?? null) === k.companyFiscalConfigId,
      );
    return l ? Number(l.proximoNumero) : null;
  }

  // ── Leituras ──

  row(nfeId: string): Linha {
    const l = this.db.linha("nfeEmitida", nfeId);
    if (!l) throw new Error(`harness: NfeEmitida ${nfeId} não existe`);
    return l;
  }

  auditLogs(nfeId: string): Linha[] {
    return this.db.tabela("nfeAuditLog").filter((l) => l.nfeId === nfeId);
  }

  /** Eventos de auditoria da nota, em ordem. */
  audit(nfeId: string): string[] {
    return this.auditLogs(nfeId).map((l) => String(l.evento));
  }

  /** Números registrados nas auditorias NUMERADA da nota, em ordem. */
  numerada(nfeId: string): number[] {
    return this.auditLogs(nfeId)
      .filter((l) => l.evento === "NUMERADA")
      .map((l) => Number(l.detalhes?.numero));
  }

  checarInvariantes(): string[] {
    return todasViolacoes(this.db, this.authority);
  }

  assertInvariantes(): void {
    const v = this.checarInvariantes();
    if (v.length > 0) throw new Error(`Invariantes violadas:\n- ${v.join("\n- ")}`);
  }

  /**
   * Roda `fn` com setTimeout/clearTimeout falsos, avançando `passoMs` até a
   * promessa assentar (polling de `pollForResult`/`pollSefazResult`, 3 s cada).
   * `Date` continua real.
   */
  async comTimersFalsos<T>(fn: () => Promise<T>, passoMs = 3000, maxIteracoes = 20): Promise<T> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let assentou = false;
      const p = fn().finally(() => {
        assentou = true;
      });
      // Evita "unhandled rejection" enquanto avançamos o relógio.
      p.catch(() => undefined);
      for (let i = 0; i < maxIteracoes && !assentou; i++) {
        await vi.advanceTimersByTimeAsync(passoMs);
      }
      if (!assentou) {
        throw new Error(`harness: promessa não assentou após ${maxIteracoes}×${passoMs}ms de timers falsos`);
      }
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  // ── Internos ──

  private resolverContador(chave: ChaveContador): {
    userId: string;
    companyFiscalConfigId: string | null;
    ambiente: string;
    serie: number;
    modelo: string;
  } {
    const modelo = chave.modelo ?? "55";
    const cfg = chave.config;
    return {
      userId: chave.userId ?? cfg?.userId ?? "user-1",
      companyFiscalConfigId:
        chave.companyFiscalConfigId !== undefined ? chave.companyFiscalConfigId : (cfg?.id ?? null),
      ambiente: chave.ambiente ?? cfg?.ambiente ?? "HOMOLOGACAO",
      serie: chave.serie ?? (modelo === "65" ? (cfg?.serieNfce ?? 1) : (cfg?.serieNfe ?? 1)),
      modelo,
    };
  }

}

let atual: EmitWorld | null = null;

/** Singleton do mundo (um por arquivo de spec). */
export function world(): EmitWorld {
  if (!atual) atual = new EmitWorld();
  return atual;
}
