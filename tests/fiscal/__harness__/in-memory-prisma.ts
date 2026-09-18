/**
 * Prisma EM MEMÓRIA para o harness de emissão (tests/fiscal/__harness__).
 *
 * Por que existe: `NfeEmissionUseCase` e `NfeRepository` chamam `prisma` direto
 * em dezenas de pontos. Para dirigir `emit()` de ponta a ponta sem banco, o spec
 * troca `app/lib/prisma` por este double via `vi.mock` (ver README.md).
 *
 * Fidelidade que importa para a numeração fiscal (e que um `vi.fn()` solto não
 * dá):
 *  - colunas do schema em 1549bc4 — escrever coluna inexistente ou tipo errado
 *    lança erro no formato do Prisma (ex.: `cStatRejeicao: "974"` em `Int?`
 *    reproduz a PrismaClientValidationError de produção, R3);
 *  - uniques de produção, inclusive os PARCIAIS de docs/multi-cnpj-sql.md
 *    (P2002), FK de itens/auditoria (P2003) e cascata de NfeItem/NfeAuditLog;
 *  - `updateMany` condicional é atômico (um statement);
 *  - `$transaction(fn)` desfaz TODAS as escritas feitas pelo cliente da
 *    transação se `fn` lançar (diário de desfazer — não restaura foto global,
 *    então escritas concorrentes de outra "conexão" não são apagadas);
 *  - SQL cru (`$queryRawUnsafe`/`$executeRawUnsafe`/`$queryRaw`/`$executeRaw`)
 *    é delegado a handlers plugáveis e LANÇA quando ninguém trata — é o ponto
 *    de extensão para o repositório fake da numeração V2.
 *
 * O que NÃO modela (e onde isso é provado): semântica real de lock/isolamento
 * do Postgres (suíte PG opt-in), `$transaction([...])` em lote (as promessas já
 * rodaram; só aguardamos), filtros por relação, agregações.
 *
 * Arquivo de TESTE: sem `vi.mock`, sem imports de módulos que os specs mockam.
 */

// ───────────────────────────── Tipos públicos ─────────────────────────────

export type NomeModelo =
  | "nfeEmitida"
  | "nfeItem"
  | "nfeAuditLog"
  | "nfeSequence"
  | "nfeInutilizacao"
  | "companyFiscalConfig"
  | "user"
  | "customer";

export const MODELOS: readonly NomeModelo[] = [
  "nfeEmitida",
  "nfeItem",
  "nfeAuditLog",
  "nfeSequence",
  "nfeInutilizacao",
  "companyFiscalConfig",
  "user",
  "customer",
];

/** Linha armazenada (valores já normalizados: Date, number, string, Json). */
export type Linha = Record<string, any>;

export type TipoSqlCru =
  | "$queryRawUnsafe"
  | "$executeRawUnsafe"
  | "$queryRaw"
  | "$executeRaw";

export interface ChamadaSqlCru {
  tipo: TipoSqlCru;
  sql: string;
  params: unknown[];
  emTransacao: boolean;
  /**
   * Registra uma ação de desfazer no diário da transação corrente (no-op fora
   * de transação). Handlers com estado próprio (ex.: fake da numeração V2)
   * usam isto para acompanhar o rollback do `$transaction`.
   */
  registrarDesfazer(fn: () => void): void;
}

/** Sentinela: o handler não reconhece este SQL — tente o próximo. */
export const SQL_NAO_TRATADO: unique symbol = Symbol("SQL_NAO_TRATADO");

export type HandlerSqlCru = (
  chamada: ChamadaSqlCru,
  db: InMemoryDb,
) => unknown | Promise<unknown>;

export interface ChamadaDelegate {
  seq: number;
  alvo: string; // "nfeEmitida.update", "$queryRawUnsafe", ...
  args: unknown;
  emTransacao: boolean;
}

export interface EscritaRegistrada {
  seq: number;
  modelo: NomeModelo;
  operacao: "create" | "update" | "delete";
  id: string;
  antes: Linha | null;
  depois: Linha | null;
  emTransacao: boolean;
}

export interface OpcoesMemoria {
  /** Relógio para defaults de createdAt/updatedAt. Default: `new Date()`. */
  relogio?: () => Date;
  /**
   * Intercala as chamadas: cada operação aguarda 0..3 microtasks escolhidos
   * por PRNG com semente (nunca timers). Útil para corridas determinísticas.
   */
  intercalar?: boolean;
  semente?: number;
}

/** Erro no formato que o código de produção inspeciona (`code`, `meta`). */
export class ErroPrismaMemoria extends Error {
  readonly code: string | undefined;
  readonly meta: Record<string, unknown> | undefined;
  readonly clientVersion = "6.2.1-harness-memoria";
  constructor(
    nome: string,
    mensagem: string,
    code?: string,
    meta?: Record<string, unknown>,
  ) {
    super(mensagem);
    this.name = nome;
    this.code = code;
    this.meta = meta;
  }
}

// ───────────────────────────── Schema (1549bc4) ─────────────────────────────

type TipoColuna = "String" | "Int" | "Boolean" | "DateTime" | "Json" | "Decimal";

interface Coluna {
  tipo: TipoColuna;
  opcional?: boolean;
  /** Valor default no create (`@default`). */
  padrao?: "id" | "agora" | (() => unknown);
  /** `@updatedAt`. */
  atualizadoEm?: boolean;
}

interface Relacao {
  modelo: NomeModelo;
  campoLocal: string;
  campoRemoto: string;
  lista: boolean;
}

interface Unico {
  nome: string;
  campos: string[];
  /** Índice parcial: só linhas que satisfazem o predicado participam. */
  quando?: (l: Linha) => boolean;
}

interface DefModelo {
  prefixoId: string;
  /** null = modelo frouxo (sem validação de coluna/tipo). */
  colunas: Record<string, Coluna> | null;
  relacoes: Record<string, Relacao>;
  unicos: Unico[];
  /** Campos aceitos em `where` de findUnique/update/delete (unique simples). */
  chavesUnicas: string[];
  fks: Array<{ campo: string; modelo: NomeModelo }>;
  /** Filhos apagados em cascata quando a linha é apagada. */
  cascata: Array<{ modelo: NomeModelo; campoRemoto: string }>;
}

const S = (opcional = false): Coluna => ({ tipo: "String", opcional });
const I = (opcional = false): Coluna => ({ tipo: "Int", opcional });
const J = (opcional = false): Coluna => ({ tipo: "Json", opcional });
const D = (opcional = false): Coluna => ({ tipo: "DateTime", opcional });
const ID: Coluna = { tipo: "String", padrao: "id" };
const CRIADO: Coluna = { tipo: "DateTime", padrao: "agora" };
const ATUALIZADO: Coluna = { tipo: "DateTime", atualizadoEm: true };

const SCHEMA: Record<NomeModelo, DefModelo> = {
  nfeEmitida: {
    prefixoId: "nfe",
    colunas: {
      id: ID,
      userId: S(),
      orderId: S(true),
      customerId: S(true),
      companyFiscalConfigId: S(true),
      ambiente: S(),
      modelo: { tipo: "String", padrao: () => "55" },
      serie: I(),
      numero: I(),
      chaveAcesso: S(true),
      tipoOperacao: S(),
      finalidade: S(),
      destinoOperacao: S(),
      naturezaOperacao: S(),
      indPresenca: S(),
      intermediador: S(true),
      numeroPedido: S(true),
      informacoesComplementares: S(true),
      dataEmissao: D(true),
      dataSaida: D(true),
      destinatarioJson: J(),
      emitenteJson: J(true),
      modalidadeFrete: S(true),
      transportadoraJson: J(true),
      valorFrete: { tipo: "Decimal", opcional: true },
      totaisJson: J(true),
      notasReferenciadasJson: J(true),
      exportacaoJson: J(true),
      pagamentosJson: J(true),
      duplicatasJson: J(true),
      volumesJson: J(true),
      status: S(),
      protocoloAutorizacao: S(true),
      dataAutorizacao: D(true),
      motivoRejeicao: S(true),
      cStatRejeicao: I(true),
      xmlOriginalPath: S(true),
      xmlAssinadoPath: S(true),
      xmlAutorizadoPath: S(true),
      danfePdfPath: S(true),
      createdAt: CRIADO,
      updatedAt: ATUALIZADO,
      emittedByUserId: S(),
    },
    relacoes: {
      itens: { modelo: "nfeItem", campoLocal: "id", campoRemoto: "nfeId", lista: true },
      eventos: { modelo: "nfeAuditLog", campoLocal: "id", campoRemoto: "nfeId", lista: true },
    },
    unicos: [
      { nome: "NfeEmitida_pkey", campos: ["id"] },
      { nome: "NfeEmitida_chaveAcesso_key", campos: ["chaveAcesso"] },
      // docs/multi-cnpj-sql.md §3e (parcial por CNPJ, só números reais).
      {
        nome: "NfeEmitida_cfcId_ambiente_serie_numero_modelo_key",
        campos: ["companyFiscalConfigId", "ambiente", "serie", "numero", "modelo"],
        quando: (l) => l.companyFiscalConfigId != null && Number(l.numero) > 0,
      },
      // docs/multi-cnpj-sql.md §5 (legado 1-CNPJ; SEM o filtro numero > 0).
      {
        nome: "NfeEmitida_legacy_null_key",
        campos: ["userId", "ambiente", "serie", "numero", "modelo"],
        quando: (l) => l.companyFiscalConfigId == null,
      },
    ],
    chavesUnicas: ["id", "chaveAcesso"],
    fks: [],
    cascata: [
      { modelo: "nfeItem", campoRemoto: "nfeId" },
      { modelo: "nfeAuditLog", campoRemoto: "nfeId" },
    ],
  },
  nfeItem: {
    prefixoId: "item",
    colunas: {
      id: ID,
      nfeId: S(),
      productId: S(true),
      numero: I(),
      codigo: S(),
      descricao: S(),
      ncm: S(),
      cfop: S(),
      cest: S(true),
      origem: I(),
      unidade: S(),
      quantidade: { tipo: "Decimal" },
      valorUnitario: { tipo: "Decimal" },
      valorTotal: { tipo: "Decimal" },
      desconto: { tipo: "Decimal", opcional: true },
      observacoes: S(true),
      tributosJson: J(true),
    },
    relacoes: {
      nfe: { modelo: "nfeEmitida", campoLocal: "nfeId", campoRemoto: "id", lista: false },
    },
    unicos: [{ nome: "NfeItem_pkey", campos: ["id"] }],
    chavesUnicas: ["id"],
    fks: [{ campo: "nfeId", modelo: "nfeEmitida" }],
    cascata: [],
  },
  nfeAuditLog: {
    prefixoId: "audit",
    colunas: {
      id: ID,
      nfeId: S(),
      userId: S(),
      evento: S(),
      detalhes: J(true),
      createdAt: CRIADO,
    },
    relacoes: {
      nfe: { modelo: "nfeEmitida", campoLocal: "nfeId", campoRemoto: "id", lista: false },
    },
    unicos: [{ nome: "NfeAuditLog_pkey", campos: ["id"] }],
    chavesUnicas: ["id"],
    fks: [{ campo: "nfeId", modelo: "nfeEmitida" }],
    cascata: [],
  },
  nfeSequence: {
    prefixoId: "seq",
    colunas: {
      id: ID,
      userId: S(),
      ambiente: S(),
      serie: I(),
      modelo: { tipo: "String", padrao: () => "55" },
      proximoNumero: { tipo: "Int", padrao: () => 1 },
      updatedAt: ATUALIZADO,
      companyFiscalConfigId: S(true),
    },
    relacoes: {},
    unicos: [
      { nome: "NfeSequence_pkey", campos: ["id"] },
      // docs/multi-cnpj-sql.md §3d e §5.
      {
        nome: "NfeSequence_cfcId_ambiente_serie_modelo_key",
        campos: ["companyFiscalConfigId", "ambiente", "serie", "modelo"],
        quando: (l) => l.companyFiscalConfigId != null,
      },
      {
        nome: "NfeSequence_legacy_null_key",
        campos: ["userId", "ambiente", "serie", "modelo"],
        quando: (l) => l.companyFiscalConfigId == null,
      },
    ],
    chavesUnicas: ["id"],
    fks: [],
    cascata: [],
  },
  nfeInutilizacao: {
    prefixoId: "inut",
    colunas: {
      id: ID,
      userId: S(),
      companyFiscalConfigId: S(true),
      ambiente: S(),
      serie: I(),
      numeroInicial: I(),
      numeroFinal: I(),
      justificativa: S(),
      protocolo: S(true),
      status: S(),
      respostaJson: J(true),
      createdAt: CRIADO,
    },
    relacoes: {},
    unicos: [{ nome: "NfeInutilizacao_pkey", campos: ["id"] }],
    chavesUnicas: ["id"],
    fks: [],
    cascata: [],
  },
  companyFiscalConfig: {
    prefixoId: "cfg",
    colunas: {
      id: ID,
      userId: S(),
      isDefault: { tipo: "Boolean", padrao: () => false },
      cnpj: S(),
      razaoSocial: S(),
      nomeFantasia: S(true),
      inscricaoEstadual: S(),
      inscricaoMunicipal: S(true),
      regimeTributario: S(),
      cnae: S(true),
      ambiente: { tipo: "String", padrao: () => "HOMOLOGACAO" },
      cep: S(true),
      logradouro: S(true),
      numero: S(true),
      complemento: S(true),
      bairro: S(true),
      municipio: S(true),
      codMunicipio: S(true),
      uf: S(true),
      codPais: { tipo: "String", opcional: true, padrao: () => "1058" },
      pais: { tipo: "String", opcional: true, padrao: () => "BRASIL" },
      certificadoPath: S(true),
      certificadoSenhaEnc: S(true),
      certificadoValidoAte: D(true),
      certificadoSubjectCN: S(true),
      providerName: S(true),
      providerToken: S(true),
      serieNfe: { tipo: "Int", padrao: () => 1 },
      serieNfce: { tipo: "Int", padrao: () => 1 },
      cscId: S(true),
      cscToken: S(true),
      ncmPadrao: S(true),
      createdAt: CRIADO,
      updatedAt: ATUALIZADO,
    },
    relacoes: {},
    unicos: [
      { nome: "CompanyFiscalConfig_pkey", campos: ["id"] },
      { nome: "CompanyFiscalConfig_userId_cnpj_key", campos: ["userId", "cnpj"] },
      {
        nome: "CompanyFiscalConfig_userId_default_key",
        campos: ["userId"],
        quando: (l) => l.isDefault === true,
      },
    ],
    chavesUnicas: ["id"],
    fks: [],
    cascata: [],
  },
  // Modelos frouxos: só o necessário para o caminho de emissão (avatar do
  // DANFE e auto-cadastro de cliente). Sem validação de coluna.
  user: {
    prefixoId: "user",
    colunas: null,
    relacoes: {},
    unicos: [{ nome: "User_pkey", campos: ["id"] }],
    chavesUnicas: ["id", "email"],
    fks: [],
    cascata: [],
  },
  customer: {
    prefixoId: "cust",
    colunas: null,
    relacoes: {},
    unicos: [{ nome: "Customer_pkey", campos: ["id"] }],
    chavesUnicas: ["id"],
    fks: [],
    cascata: [],
  },
};

// ───────────────────────────── Utilidades ─────────────────────────────

function clonar<T>(v: T): T {
  if (v === null || v === undefined) return v;
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}

function ehObjetoSimples(v: unknown): v is Record<string, any> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Uint8Array)
  );
}

function valorComparavel(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  if (ehObjetoSimples(v) && typeof (v as any).toNumber === "function") {
    return (v as any).toNumber();
  }
  return v;
}

function iguais(a: unknown, b: unknown): boolean {
  const x = valorComparavel(a);
  const y = valorComparavel(b);
  if (x === null || x === undefined) return y === null || y === undefined;
  return x === y;
}

function comparar(a: unknown, b: unknown): number {
  const x = valorComparavel(a) as any;
  const y = valorComparavel(b) as any;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/** PRNG pequeno e determinístico (mulberry32). */
function prng(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function naoSuportado(o: string): never {
  throw new ErroPrismaMemoria(
    "InMemoryPrismaNaoSuportado",
    `in-memory-prisma: ${o} não é suportado pelo double — estenda tests/fiscal/__harness__/in-memory-prisma.ts se o código de produção passou a usar isto.`,
  );
}

function erroValidacao(mensagem: string): ErroPrismaMemoria {
  return new ErroPrismaMemoria("PrismaClientValidationError", mensagem);
}

// ───────────────────────────── Contexto de execução ─────────────────────────────

interface Contexto {
  /** Diário de desfazer da transação; null fora de transação. */
  diario: Array<() => void> | null;
}

// ───────────────────────────── Núcleo ─────────────────────────────

export interface InMemoryDb {
  /** O double que substitui `prisma` (`default` do módulo mockado). */
  readonly client: InMemoryPrismaClient;
  reset(opcoes?: OpcoesMemoria): void;
  /** Cópia das linhas de uma tabela, na ordem de inserção. */
  tabela(modelo: NomeModelo): Linha[];
  /** Cópia de uma linha por id (null se não existe). */
  linha(modelo: NomeModelo, id: string): Linha | null;
  /** Insere aplicando defaults, validação e uniques (para seeds). Síncrono. */
  inserir(modelo: NomeModelo, data: Linha): Linha;
  /** Atualiza uma linha por id com validação e uniques (para seeds). Síncrono. */
  atualizar(modelo: NomeModelo, id: string, data: Linha): Linha;
  /** Registra handler de SQL cru; devolve função para remover. */
  aoSqlCru(handler: HandlerSqlCru): () => void;
  /**
   * Faz a PRÓXIMA chamada que casar `alvo` (ex.: "nfeEmitida.update",
   * "$queryRawUnsafe") lançar `erro`. `quando` filtra pelos argumentos.
   */
  falharProxima(
    alvo: string,
    erro: Error | (() => Error),
    quando?: (args: any) => boolean,
  ): void;
  chamadas(filtroAlvo?: string): ChamadaDelegate[];
  escritas(modelo?: NomeModelo): EscritaRegistrada[];
}

type Delegate = Record<string, (args?: any) => Promise<any>>;

export interface InMemoryPrismaClient {
  nfeEmitida: Delegate;
  nfeItem: Delegate;
  nfeAuditLog: Delegate;
  nfeSequence: Delegate;
  nfeInutilizacao: Delegate;
  companyFiscalConfig: Delegate;
  user: Delegate;
  customer: Delegate;
  $transaction: (arg: any, opcoes?: unknown) => Promise<any>;
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<any>;
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<any>;
  $queryRaw: (sql: any, ...valores: unknown[]) => Promise<any>;
  $executeRaw: (sql: any, ...valores: unknown[]) => Promise<any>;
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
}

export function createInMemoryPrisma(opcoes: OpcoesMemoria = {}): InMemoryDb {
  let estado: Record<NomeModelo, Linha[]> = tabelasVazias();
  let contadores: Record<string, number> = {};
  let relogio: () => Date = opcoes.relogio ?? (() => new Date());
  let aleatorio: (() => number) | null = opcoes.intercalar
    ? prng(opcoes.semente ?? 1)
    : null;
  let handlers: HandlerSqlCru[] = [];
  let falhas: Array<{
    alvo: string;
    erro: Error | (() => Error);
    quando?: (args: any) => boolean;
  }> = [];
  let registroChamadas: ChamadaDelegate[] = [];
  let registroEscritas: EscritaRegistrada[] = [];
  let seq = 0;

  function tabelasVazias(): Record<NomeModelo, Linha[]> {
    const t = {} as Record<NomeModelo, Linha[]>;
    for (const m of MODELOS) t[m] = [];
    return t;
  }

  function gerarId(modelo: NomeModelo): string {
    const prefixo = SCHEMA[modelo].prefixoId;
    contadores[prefixo] = (contadores[prefixo] ?? 0) + 1;
    return `${prefixo}-${String(contadores[prefixo]).padStart(4, "0")}`;
  }

  async function pausa(): Promise<void> {
    if (!aleatorio) return;
    const saltos = Math.floor(aleatorio() * 4);
    for (let i = 0; i < saltos; i++) await Promise.resolve();
  }

  function verificarFalha(alvo: string, args: unknown): void {
    const idx = falhas.findIndex(
      (f) => f.alvo === alvo && (!f.quando || f.quando(args)),
    );
    if (idx < 0) return;
    const [f] = falhas.splice(idx, 1);
    throw typeof f.erro === "function" ? f.erro() : f.erro;
  }

  function registrarEscrita(
    ctx: Contexto,
    modelo: NomeModelo,
    operacao: EscritaRegistrada["operacao"],
    antes: Linha | null,
    depois: Linha | null,
  ): void {
    registroEscritas.push({
      seq: ++seq,
      modelo,
      operacao,
      id: String((depois ?? antes)?.id ?? ""),
      antes: clonar(antes),
      depois: clonar(depois),
      emTransacao: ctx.diario !== null,
    });
  }

  // ── Filtros ──

  function casa(modelo: NomeModelo, linha: Linha, where: unknown): boolean {
    if (where === undefined || where === null) return true;
    if (!ehObjetoSimples(where)) naoSuportado(`where não-objeto em ${modelo}`);
    const def = SCHEMA[modelo];
    for (const [campo, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (campo === "AND") {
        const lista = Array.isArray(cond) ? cond : [cond];
        if (!lista.every((c) => casa(modelo, linha, c))) return false;
        continue;
      }
      if (campo === "OR") {
        if (!Array.isArray(cond)) naoSuportado("OR não-array");
        if (!cond.some((c: unknown) => casa(modelo, linha, c))) return false;
        continue;
      }
      if (campo === "NOT") {
        const lista = Array.isArray(cond) ? cond : [cond];
        if (lista.some((c) => casa(modelo, linha, c))) return false;
        continue;
      }
      if (def.relacoes[campo]) {
        naoSuportado(`filtro por relação "${modelo}.${campo}"`);
      }
      if (def.colunas && !def.colunas[campo]) {
        throw erroValidacao(
          `Unknown argument \`${campo}\` em where de ${modelo} (coluna inexistente no schema).`,
        );
      }
      if (!casaCampo(linha[campo], cond)) return false;
    }
    return true;
  }

  function casaCampo(valor: unknown, cond: unknown): boolean {
    if (cond === null) return valor === null || valor === undefined;
    if (!ehObjetoSimples(cond)) return iguais(valor, cond);
    const modoInsensivel = cond.mode === "insensitive";
    const texto = (v: unknown) =>
      modoInsensivel ? String(v).toLowerCase() : String(v);
    for (const [op, alvo] of Object.entries(cond)) {
      if (alvo === undefined || op === "mode") continue;
      const nulo = valor === null || valor === undefined;
      switch (op) {
        case "equals":
          if (!iguais(valor, alvo)) return false;
          break;
        case "in":
          if (nulo || !(alvo as unknown[]).some((a) => iguais(valor, a))) return false;
          break;
        case "notIn":
          // SQL: NULL NOT IN (...) é desconhecido ⇒ linha fora.
          if (nulo || (alvo as unknown[]).some((a) => iguais(valor, a))) return false;
          break;
        case "not":
          if (alvo === null) {
            if (nulo) return false;
          } else if (ehObjetoSimples(alvo)) {
            if (casaCampo(valor, alvo)) return false;
          } else {
            // Prisma/SQL: `<>` exclui NULL (gotcha conhecido do `not`).
            if (nulo || iguais(valor, alvo)) return false;
          }
          break;
        case "lt":
          if (nulo || !(comparar(valor, alvo) < 0)) return false;
          break;
        case "lte":
          if (nulo || !(comparar(valor, alvo) <= 0)) return false;
          break;
        case "gt":
          if (nulo || !(comparar(valor, alvo) > 0)) return false;
          break;
        case "gte":
          if (nulo || !(comparar(valor, alvo) >= 0)) return false;
          break;
        case "contains":
          if (nulo || !texto(valor).includes(texto(alvo))) return false;
          break;
        case "startsWith":
          if (nulo || !texto(valor).startsWith(texto(alvo))) return false;
          break;
        case "endsWith":
          if (nulo || !texto(valor).endsWith(texto(alvo))) return false;
          break;
        default:
          naoSuportado(`operador de filtro "${op}"`);
      }
    }
    return true;
  }

  // ── Ordenação e projeção ──

  function ordenar(modelo: NomeModelo, linhas: Linha[], orderBy: unknown): Linha[] {
    if (orderBy === undefined || orderBy === null) return linhas;
    const lista = Array.isArray(orderBy) ? orderBy : [orderBy];
    const criterios: Array<{ campo: string; dir: 1 | -1; nulosPrimeiro: boolean }> = [];
    for (const item of lista) {
      if (!ehObjetoSimples(item)) naoSuportado("orderBy não-objeto");
      for (const [campo, v] of Object.entries(item)) {
        if (SCHEMA[modelo].relacoes[campo]) naoSuportado(`orderBy por relação "${campo}"`);
        const sort = ehObjetoSimples(v) ? v.sort : v;
        const dir: 1 | -1 = sort === "desc" ? -1 : 1;
        // Postgres: ASC ⇒ NULLS LAST; DESC ⇒ NULLS FIRST (salvo `nulls` explícito).
        const nulls = ehObjetoSimples(v) ? v.nulls : undefined;
        const nulosPrimeiro = nulls ? nulls === "first" : dir === -1;
        criterios.push({ campo, dir, nulosPrimeiro });
      }
    }
    const indexada = linhas.map((l, i) => ({ l, i }));
    indexada.sort((a, b) => {
      for (const c of criterios) {
        const va = a.l[c.campo];
        const vb = b.l[c.campo];
        const na = va === null || va === undefined;
        const nb = vb === null || vb === undefined;
        if (na && nb) continue;
        if (na) return c.nulosPrimeiro ? -1 : 1;
        if (nb) return c.nulosPrimeiro ? 1 : -1;
        const r = comparar(va, vb) * c.dir;
        if (r !== 0) return r;
      }
      return a.i - b.i;
    });
    return indexada.map((x) => x.l);
  }

  function paginar(linhas: Linha[], args: any): Linha[] {
    let r = linhas;
    if (typeof args?.skip === "number") r = r.slice(args.skip);
    if (typeof args?.take === "number") {
      if (args.take < 0) naoSuportado("take negativo");
      r = r.slice(0, args.take);
    }
    return r;
  }

  function carregarRelacao(
    modelo: NomeModelo,
    linha: Linha,
    nome: string,
    sub: any,
  ): unknown {
    const rel = SCHEMA[modelo].relacoes[nome];
    if (!rel) {
      throw erroValidacao(`Unknown field \`${nome}\` for include/select de ${modelo}.`);
    }
    const argsSub = sub === true ? {} : (sub ?? {});
    let filhos = estado[rel.modelo].filter(
      (f) =>
        iguais(f[rel.campoRemoto], linha[rel.campoLocal]) &&
        casa(rel.modelo, f, argsSub.where),
    );
    filhos = ordenar(rel.modelo, filhos, argsSub.orderBy);
    filhos = paginar(filhos, argsSub);
    const projetados = filhos.map((f) => projetar(rel.modelo, f, argsSub));
    return rel.lista ? projetados : (projetados[0] ?? null);
  }

  function projetar(modelo: NomeModelo, linha: Linha, args: any): Linha {
    if (args?.select && args?.include) {
      throw erroValidacao("Please either use `include` or `select`, but not both.");
    }
    if (ehObjetoSimples(args?.select)) {
      const out: Linha = {};
      for (const [campo, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (campo === "_count") naoSuportado("select._count");
        if (SCHEMA[modelo].relacoes[campo]) {
          out[campo] = carregarRelacao(modelo, linha, campo, v);
        } else {
          if (SCHEMA[modelo].colunas && !SCHEMA[modelo].colunas![campo]) {
            throw erroValidacao(`Unknown field \`${campo}\` for select de ${modelo}.`);
          }
          out[campo] = clonar(linha[campo] ?? null);
        }
      }
      return out;
    }
    const out = clonar(linha);
    if (ehObjetoSimples(args?.include)) {
      for (const [campo, v] of Object.entries(args.include)) {
        if (!v) continue;
        if (campo === "_count") naoSuportado("include._count");
        out[campo] = carregarRelacao(modelo, linha, campo, v);
      }
    }
    return out;
  }

  // ── Validação e escrita ──

  function normalizarValor(
    modelo: NomeModelo,
    campo: string,
    valor: unknown,
  ): unknown {
    const col = SCHEMA[modelo].colunas?.[campo];
    if (!col) return clonar(valor);
    if (valor === null) {
      if (!col.opcional) {
        throw erroValidacao(
          `Invalid \`prisma.${modelo}\` invocation: Argument \`${campo}\` must not be null.`,
        );
      }
      return null;
    }
    const provided = Array.isArray(valor)
      ? "List"
      : valor instanceof Date
        ? "DateTime"
        : typeof valor === "number"
          ? Number.isInteger(valor)
            ? "Int"
            : "Float"
          : typeof valor === "string"
            ? "String"
            : typeof valor === "boolean"
              ? "Boolean"
              : "Object";
    const invalido = (esperado: string) =>
      erroValidacao(
        `Invalid \`prisma.${modelo}\` invocation: Argument \`${campo}\`: Invalid value provided. Expected ${esperado}, provided ${provided}.`,
      );
    switch (col.tipo) {
      case "String":
        if (typeof valor !== "string") throw invalido("String");
        return valor;
      case "Int":
        if (typeof valor !== "number" || !Number.isInteger(valor)) throw invalido("Int");
        return valor;
      case "Boolean":
        if (typeof valor !== "boolean") throw invalido("Boolean");
        return valor;
      case "DateTime": {
        if (valor instanceof Date) return new Date(valor.getTime());
        if (typeof valor === "string" && !Number.isNaN(Date.parse(valor))) {
          return new Date(valor);
        }
        throw invalido("DateTime");
      }
      case "Decimal": {
        const n =
          typeof valor === "number"
            ? valor
            : typeof valor === "string"
              ? Number(valor)
              : ehObjetoSimples(valor) && typeof (valor as any).toNumber === "function"
                ? (valor as any).toNumber()
                : NaN;
        if (!Number.isFinite(n)) throw invalido("Decimal");
        return n;
      }
      case "Json":
        return clonar(valor);
    }
  }

  function aplicarOperadorEscalar(
    modelo: NomeModelo,
    campo: string,
    atual: unknown,
    v: Record<string, any>,
  ): unknown {
    const ops = Object.keys(v).filter((k) => v[k] !== undefined);
    if (ops.length !== 1) naoSuportado(`update com operadores ${ops.join(",")} em ${campo}`);
    const [op] = ops;
    const arg = v[op];
    switch (op) {
      case "set":
        return arg;
      case "increment":
        return Number(atual) + Number(arg);
      case "decrement":
        return Number(atual) - Number(arg);
      case "multiply":
        return Number(atual) * Number(arg);
      case "divide":
        return Number(atual) / Number(arg);
      default:
        return naoSuportado(`operador de update "${op}" em ${modelo}.${campo}`);
    }
  }

  interface EscritaAninhada {
    relacao: string;
    ops: Record<string, any>;
  }

  /** Monta a linha candidata; devolve escritas aninhadas pendentes. */
  function montarLinha(
    modelo: NomeModelo,
    base: Linha | null,
    data: Record<string, any>,
  ): { linha: Linha; aninhadas: EscritaAninhada[] } {
    const def = SCHEMA[modelo];
    const linha: Linha = base ? { ...base } : {};
    const aninhadas: EscritaAninhada[] = [];
    const agora = relogio();
    for (const [campo, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (def.relacoes[campo]) {
        if (!ehObjetoSimples(v)) naoSuportado(`escrita aninhada não-objeto em ${campo}`);
        aninhadas.push({ relacao: campo, ops: v });
        continue;
      }
      if (def.colunas && !def.colunas[campo]) {
        throw erroValidacao(
          `Invalid \`prisma.${modelo}\` invocation: Unknown argument \`${campo}\`. (coluna inexistente no schema de 1549bc4)`,
        );
      }
      const col = def.colunas?.[campo];
      let bruto: unknown = v;
      if (col && col.tipo !== "Json" && ehObjetoSimples(v) && !(col.tipo === "Decimal" && typeof v.toNumber === "function")) {
        bruto = aplicarOperadorEscalar(modelo, campo, linha[campo], v);
      }
      linha[campo] = normalizarValor(modelo, campo, bruto);
    }
    if (def.colunas) {
      for (const [campo, col] of Object.entries(def.colunas)) {
        if (!base && (linha[campo] === undefined)) {
          if (col.padrao === "id") linha[campo] = gerarId(modelo);
          else if (col.padrao === "agora") linha[campo] = new Date(agora.getTime());
          else if (typeof col.padrao === "function") linha[campo] = col.padrao();
          else if (col.atualizadoEm) linha[campo] = new Date(agora.getTime());
          else if (col.opcional) linha[campo] = null;
          else {
            throw erroValidacao(
              `Invalid \`prisma.${modelo}.create()\` invocation: Argument \`${campo}\` is missing.`,
            );
          }
        }
        if (base && col.atualizadoEm && data[campo] === undefined) {
          linha[campo] = new Date(agora.getTime());
        }
      }
    } else if (!base && (linha.id === undefined || linha.id === null)) {
      linha.id = gerarId(modelo);
    }
    return { linha, aninhadas };
  }

  function verificarUnicos(
    modelo: NomeModelo,
    candidatas: Linha[],
    tabelaProposta: Linha[],
  ): void {
    for (const u of SCHEMA[modelo].unicos) {
      for (const c of candidatas) {
        if (u.quando && !u.quando(c)) continue;
        if (u.campos.some((f) => c[f] === null || c[f] === undefined)) continue;
        const conflito = tabelaProposta.some(
          (o) =>
            o !== c &&
            (!u.quando || u.quando(o)) &&
            u.campos.every((f) => iguais(o[f], c[f])),
        );
        if (conflito) {
          throw new ErroPrismaMemoria(
            "PrismaClientKnownRequestError",
            `Unique constraint failed on the fields: (${u.campos.map((f) => `\`${f}\``).join(",")}) [${u.nome}]`,
            "P2002",
            { target: u.campos, modelName: modelo, index: u.nome },
          );
        }
      }
    }
  }

  function verificarFks(modelo: NomeModelo, linha: Linha): void {
    for (const fk of SCHEMA[modelo].fks) {
      const v = linha[fk.campo];
      if (v === null || v === undefined) continue;
      if (!estado[fk.modelo].some((p) => p.id === v)) {
        throw new ErroPrismaMemoria(
          "PrismaClientKnownRequestError",
          `Foreign key constraint violated: \`${modelo}_${fk.campo}_fkey (index)\``,
          "P2003",
          { field_name: `${modelo}_${fk.campo}_fkey (index)`, modelName: modelo },
        );
      }
    }
  }

  function inserirLinha(ctx: Contexto, modelo: NomeModelo, linha: Linha): void {
    const tabela = estado[modelo];
    verificarUnicos(modelo, [linha], [...tabela, linha]);
    verificarFks(modelo, linha);
    tabela.push(linha);
    registrarEscrita(ctx, modelo, "create", null, linha);
    ctx.diario?.push(() => {
      const i = tabela.indexOf(linha);
      if (i >= 0) tabela.splice(i, 1);
    });
  }

  function substituirLinhas(
    ctx: Contexto,
    modelo: NomeModelo,
    trocas: Map<Linha, Linha>,
  ): void {
    if (trocas.size === 0) return;
    const tabela = estado[modelo];
    const proposta = tabela.map((l) => trocas.get(l) ?? l);
    const novas = [...trocas.values()];
    verificarUnicos(modelo, novas, proposta);
    for (const n of novas) verificarFks(modelo, n);
    for (const [antiga, nova] of trocas) {
      const i = tabela.indexOf(antiga);
      if (i < 0) continue;
      tabela[i] = nova;
      registrarEscrita(ctx, modelo, "update", antiga, nova);
      ctx.diario?.push(() => {
        const j = tabela.indexOf(nova);
        if (j >= 0) tabela[j] = antiga;
      });
    }
  }

  function removerLinha(ctx: Contexto, modelo: NomeModelo, linha: Linha): void {
    for (const filho of SCHEMA[modelo].cascata) {
      for (const f of estado[filho.modelo].filter((x) => iguais(x[filho.campoRemoto], linha.id))) {
        removerLinha(ctx, filho.modelo, f);
      }
    }
    const tabela = estado[modelo];
    const i = tabela.indexOf(linha);
    if (i < 0) return;
    tabela.splice(i, 1);
    registrarEscrita(ctx, modelo, "delete", linha, null);
    ctx.diario?.push(() => {
      tabela.splice(Math.min(i, tabela.length), 0, linha);
    });
  }

  function executarAninhadas(
    ctx: Contexto,
    modelo: NomeModelo,
    pai: Linha,
    aninhadas: EscritaAninhada[],
  ): void {
    for (const { relacao, ops } of aninhadas) {
      const rel = SCHEMA[modelo].relacoes[relacao];
      if (!rel.lista) naoSuportado(`escrita aninhada em relação 1:1 "${relacao}"`);
      for (const [op, arg] of Object.entries(ops)) {
        if (arg === undefined) continue;
        if (op === "deleteMany") {
          const where = arg === true ? {} : arg;
          for (const f of estado[rel.modelo].filter(
            (x) => iguais(x[rel.campoRemoto], pai[rel.campoLocal]) && casa(rel.modelo, x, where),
          )) {
            removerLinha(ctx, rel.modelo, f);
          }
        } else if (op === "create") {
          for (const d of Array.isArray(arg) ? arg : [arg]) {
            const { linha } = montarLinha(rel.modelo, null, {
              ...d,
              [rel.campoRemoto]: pai[rel.campoLocal],
            });
            inserirLinha(ctx, rel.modelo, linha);
          }
        } else if (op === "createMany") {
          for (const d of arg.data ?? []) {
            const { linha } = montarLinha(rel.modelo, null, {
              ...d,
              [rel.campoRemoto]: pai[rel.campoLocal],
            });
            inserirLinha(ctx, rel.modelo, linha);
          }
        } else {
          naoSuportado(`escrita aninhada "${relacao}.${op}"`);
        }
      }
    }
  }

  function exigirWhereUnico(modelo: NomeModelo, operacao: string, where: any): void {
    const chaves = SCHEMA[modelo].chavesUnicas;
    if (!ehObjetoSimples(where) || !chaves.some((k) => where[k] !== undefined && where[k] !== null)) {
      throw erroValidacao(
        `Invalid \`prisma.${modelo}.${operacao}()\` invocation: Argument \`where\` of type ${modelo}WhereUniqueInput needs at least one of ${chaves.map((k) => `\`${k}\``).join(", ")} arguments.`,
      );
    }
  }

  function naoEncontrado(modelo: NomeModelo, operacao: string): ErroPrismaMemoria {
    return new ErroPrismaMemoria(
      "PrismaClientKnownRequestError",
      `An operation failed because it depends on one or more records that were required but not found. Record to ${operacao} not found. (${modelo})`,
      "P2025",
      { modelName: modelo, cause: `Record to ${operacao} not found.` },
    );
  }

  // ── Delegates ──

  function criarDelegate(modelo: NomeModelo, ctx: Contexto): Delegate {
    const envolver =
      (operacao: string, fn: (args: any) => any) =>
      async (args: any = {}) => {
        const alvo = `${modelo}.${operacao}`;
        registroChamadas.push({
          seq: ++seq,
          alvo,
          args: clonar(args),
          emTransacao: ctx.diario !== null,
        });
        await pausa();
        verificarFalha(alvo, args);
        return fn(args);
      };

    const encontrar = (args: any) =>
      paginar(ordenar(modelo, estado[modelo].filter((l) => casa(modelo, l, args?.where)), args?.orderBy), args);

    return {
      findMany: envolver("findMany", (args) => {
        if (args?.distinct) naoSuportado("findMany.distinct");
        return encontrar(args).map((l) => projetar(modelo, l, args));
      }),
      findFirst: envolver("findFirst", (args) => {
        const [l] = encontrar({ ...args, take: 1 });
        return l ? projetar(modelo, l, args) : null;
      }),
      findFirstOrThrow: envolver("findFirstOrThrow", (args) => {
        const [l] = encontrar({ ...args, take: 1 });
        if (!l) throw naoEncontrado(modelo, "find");
        return projetar(modelo, l, args);
      }),
      findUnique: envolver("findUnique", (args) => {
        exigirWhereUnico(modelo, "findUnique", args?.where);
        const l = estado[modelo].find((x) => casa(modelo, x, args.where));
        return l ? projetar(modelo, l, args) : null;
      }),
      findUniqueOrThrow: envolver("findUniqueOrThrow", (args) => {
        exigirWhereUnico(modelo, "findUniqueOrThrow", args?.where);
        const l = estado[modelo].find((x) => casa(modelo, x, args.where));
        if (!l) throw naoEncontrado(modelo, "find");
        return projetar(modelo, l, args);
      }),
      count: envolver("count", (args) => {
        if (args?.select) naoSuportado("count.select");
        return estado[modelo].filter((l) => casa(modelo, l, args?.where)).length;
      }),
      create: envolver("create", (args) => {
        const { linha, aninhadas } = montarLinha(modelo, null, args?.data ?? {});
        inserirLinha(ctx, modelo, linha);
        executarAninhadas(ctx, modelo, linha, aninhadas);
        return projetar(modelo, linha, args);
      }),
      createMany: envolver("createMany", (args) => {
        const lista: any[] = Array.isArray(args?.data) ? args.data : [args?.data];
        let count = 0;
        for (const d of lista) {
          const { linha, aninhadas } = montarLinha(modelo, null, d);
          if (aninhadas.length) naoSuportado("createMany com escrita aninhada");
          try {
            inserirLinha(ctx, modelo, linha);
            count++;
          } catch (e) {
            if (args?.skipDuplicates && (e as ErroPrismaMemoria).code === "P2002") continue;
            throw e;
          }
        }
        return { count };
      }),
      update: envolver("update", (args) => {
        exigirWhereUnico(modelo, "update", args?.where);
        const atual = estado[modelo].find((x) => casa(modelo, x, args.where));
        if (!atual) throw naoEncontrado(modelo, "update");
        const { linha, aninhadas } = montarLinha(modelo, atual, args?.data ?? {});
        substituirLinhas(ctx, modelo, new Map([[atual, linha]]));
        executarAninhadas(ctx, modelo, linha, aninhadas);
        return projetar(modelo, linha, args);
      }),
      updateMany: envolver("updateMany", (args) => {
        const alvo = estado[modelo].filter((l) => casa(modelo, l, args?.where));
        const trocas = new Map<Linha, Linha>();
        for (const atual of alvo) {
          const { linha, aninhadas } = montarLinha(modelo, atual, args?.data ?? {});
          if (aninhadas.length) naoSuportado("updateMany com escrita aninhada");
          trocas.set(atual, linha);
        }
        substituirLinhas(ctx, modelo, trocas);
        return { count: trocas.size };
      }),
      upsert: envolver("upsert", (args) => {
        exigirWhereUnico(modelo, "upsert", args?.where);
        const atual = estado[modelo].find((x) => casa(modelo, x, args.where));
        if (atual) {
          const { linha, aninhadas } = montarLinha(modelo, atual, args?.update ?? {});
          substituirLinhas(ctx, modelo, new Map([[atual, linha]]));
          executarAninhadas(ctx, modelo, linha, aninhadas);
          return projetar(modelo, linha, args);
        }
        const { linha, aninhadas } = montarLinha(modelo, null, args?.create ?? {});
        inserirLinha(ctx, modelo, linha);
        executarAninhadas(ctx, modelo, linha, aninhadas);
        return projetar(modelo, linha, args);
      }),
      delete: envolver("delete", (args) => {
        exigirWhereUnico(modelo, "delete", args?.where);
        const atual = estado[modelo].find((x) => casa(modelo, x, args.where));
        if (!atual) throw naoEncontrado(modelo, "delete");
        const projetada = projetar(modelo, atual, args);
        removerLinha(ctx, modelo, atual);
        return projetada;
      }),
      deleteMany: envolver("deleteMany", (args) => {
        const alvo = estado[modelo].filter((l) => casa(modelo, l, args?.where));
        for (const l of alvo) removerLinha(ctx, modelo, l);
        return { count: alvo.length };
      }),
      aggregate: envolver("aggregate", () => naoSuportado(`${modelo}.aggregate`)),
      groupBy: envolver("groupBy", () => naoSuportado(`${modelo}.groupBy`)),
    };
  }

  // ── SQL cru ──

  function textoSql(sql: any, valores: unknown[]): { sql: string; params: unknown[] } {
    if (typeof sql === "string") return { sql, params: valores };
    if (Array.isArray(sql) && "raw" in (sql as any)) {
      const partes = sql as unknown as string[];
      return {
        sql: partes.reduce((acc, p, i) => (i === 0 ? p : `${acc}$${i}${p}`), ""),
        params: valores,
      };
    }
    if (ehObjetoSimples(sql) && typeof sql.sql === "string") {
      return { sql: sql.sql, params: Array.isArray(sql.values) ? sql.values : [] };
    }
    return naoSuportado("formato de SQL cru desconhecido");
  }

  function criarSqlCru(tipo: TipoSqlCru, ctx: Contexto) {
    return async (sql: any, ...valores: unknown[]) => {
      const { sql: texto, params } = textoSql(sql, valores);
      registroChamadas.push({
        seq: ++seq,
        alvo: tipo,
        args: { sql: texto, params: clonar(params) },
        emTransacao: ctx.diario !== null,
      });
      await pausa();
      verificarFalha(tipo, { sql: texto, params });
      const chamada: ChamadaSqlCru = {
        tipo,
        sql: texto,
        params,
        emTransacao: ctx.diario !== null,
        registrarDesfazer: (fn) => {
          ctx.diario?.push(fn);
        },
      };
      for (const h of handlers) {
        const r = await h(chamada, db);
        if (r !== SQL_NAO_TRATADO) return r;
      }
      throw new ErroPrismaMemoria(
        "InMemoryPrismaSqlCruNaoTratado",
        `in-memory-prisma: ${tipo} sem handler registrado (use db.aoSqlCru). SQL: ${texto.replace(/\s+/g, " ").trim().slice(0, 240)}`,
      );
    };
  }

  // ── Clientes (raiz e de transação) ──

  function criarCliente(ctx: Contexto): InMemoryPrismaClient {
    const cliente: InMemoryPrismaClient = {
      nfeEmitida: criarDelegate("nfeEmitida", ctx),
      nfeItem: criarDelegate("nfeItem", ctx),
      nfeAuditLog: criarDelegate("nfeAuditLog", ctx),
      nfeSequence: criarDelegate("nfeSequence", ctx),
      nfeInutilizacao: criarDelegate("nfeInutilizacao", ctx),
      companyFiscalConfig: criarDelegate("companyFiscalConfig", ctx),
      user: criarDelegate("user", ctx),
      customer: criarDelegate("customer", ctx),
      $queryRawUnsafe: criarSqlCru("$queryRawUnsafe", ctx),
      $executeRawUnsafe: criarSqlCru("$executeRawUnsafe", ctx),
      $queryRaw: criarSqlCru("$queryRaw", ctx),
      $executeRaw: criarSqlCru("$executeRaw", ctx),
      $connect: async () => undefined,
      $disconnect: async () => undefined,
      $transaction: async (arg: any) => {
        if (ctx.diario !== null) {
          // O cliente interativo do Prisma não expõe $transaction aninhada.
          naoSuportado("$transaction aninhada dentro de uma transação interativa");
        }
        if (Array.isArray(arg)) {
          // Lote: as operações já foram disparadas pelo cliente raiz.
          registroChamadas.push({ seq: ++seq, alvo: "$transaction[]", args: null, emTransacao: false });
          return Promise.all(arg);
        }
        if (typeof arg !== "function") naoSuportado("$transaction com argumento não-função");
        registroChamadas.push({ seq: ++seq, alvo: "$transaction", args: null, emTransacao: false });
        const diario: Array<() => void> = [];
        const tx = criarCliente({ diario });
        // O cliente de transação do Prisma não tem $transaction/$connect.
        delete (tx as Partial<InMemoryPrismaClient>).$transaction;
        try {
          return await arg(tx);
        } catch (e) {
          for (let i = diario.length - 1; i >= 0; i--) diario[i]();
          throw e;
        }
      },
    };
    return cliente;
  }

  const client = criarCliente({ diario: null });

  const db: InMemoryDb = {
    client,
    reset(novas?: OpcoesMemoria) {
      const o = novas ?? {};
      estado = tabelasVazias();
      contadores = {};
      relogio = o.relogio ?? opcoes.relogio ?? (() => new Date());
      aleatorio = o.intercalar ? prng(o.semente ?? 1) : null;
      handlers = [];
      falhas = [];
      registroChamadas = [];
      registroEscritas = [];
      seq = 0;
    },
    tabela(modelo) {
      return estado[modelo].map((l) => clonar(l));
    },
    linha(modelo, id) {
      const l = estado[modelo].find((x) => x.id === id);
      return l ? clonar(l) : null;
    },
    inserir(modelo, data) {
      const ctx: Contexto = { diario: null };
      const { linha, aninhadas } = montarLinha(modelo, null, data);
      inserirLinha(ctx, modelo, linha);
      executarAninhadas(ctx, modelo, linha, aninhadas);
      return clonar(linha);
    },
    atualizar(modelo, id, data) {
      const ctx: Contexto = { diario: null };
      const atual = estado[modelo].find((x) => x.id === id);
      if (!atual) throw naoEncontrado(modelo, "update");
      const { linha, aninhadas } = montarLinha(modelo, atual, data);
      substituirLinhas(ctx, modelo, new Map([[atual, linha]]));
      executarAninhadas(ctx, modelo, linha, aninhadas);
      return clonar(linha);
    },
    aoSqlCru(handler) {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
    },
    falharProxima(alvo, erro, quando) {
      falhas.push({ alvo, erro, quando });
    },
    chamadas(filtroAlvo) {
      return registroChamadas.filter((c) => !filtroAlvo || c.alvo === filtroAlvo);
    },
    escritas(modelo) {
      return registroEscritas.filter((e) => !modelo || e.modelo === modelo);
    },
  };

  return db;
}
