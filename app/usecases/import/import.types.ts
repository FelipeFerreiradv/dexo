/**
 * Contratos do motor de importação de dados legados (painel Superadmin).
 *
 * Fluxo: parse → detecção por assinatura de colunas → executor da entidade.
 * O PREVIEW roda o MESMO executor com `dryRun=true` (zero escritas — o mesmo
 * padrão dos scripts de migração validados em produção); o APPLY roda com
 * `dryRun=false` dentro de um job assíncrono com progresso.
 *
 * Regra de ouro: escrita SEMPRE pelos UseCases validados (Customer/Location/
 * Scrap/Finance/Product) — nunca prisma cru. Leituras de preload podem ser
 * diretas (são read-only).
 */

// IBR = export "tabular" novo do IBR/WebDesmonte (issue IBR-4243): estoque.csv
// (produtos + localização em texto) e nfe_emitidas.csv (NF-e emitidas). É um
// FORMATO distinto do WEBDESMONTE "clássico" (locations/purchase_waste/
// products/customers com GUIDs), por isso um sistema próprio.
// IBRSOFT = export COMPLETO do IBR Soft moderno (CSV separado por ";", colunas
// em português snake_case): produtos.csv, sucatas.csv, localizacoes.csv,
// costumers.csv, nfe.csv, contas_a_pagar.csv, contas_a_receber.csv. Um único
// PACOTE cobre todas as entidades.
export type ImportSystem =
  | "VAAPT"
  | "WEBDESMONTE"
  | "DEXO"
  | "IBR"
  | "IBRSOFT";

export type ImportEntity =
  | "CLIENTES"
  | "LOCALIZACOES"
  | "SUCATAS"
  | "VINCULOS"
  | "CONTAS"
  | "NFE"
  | "PACOTE"
  // Fotos das peças do sistema legado: casa a peça pelo SKU e preenche
  // imageUrl/imageUrls de quem ainda não tem imagem.
  | "FOTOS"
  // Estoque IBR: cria a árvore de localizações do próprio arquivo, casa o
  // produto por SKU (vincula a localização) e cria os produtos faltantes.
  | "ESTOQUE";

/**
 * Arquivo recebido no multipart, já em memória. Os tetos (por arquivo, por
 * somatório e por quantidade) vivem em `lib/import-limits.ts` e são aplicados
 * na rota — NÃO são os 20MB globais do api.ts, que valem para as rotas de
 * imagem.
 */
export interface ImportFile {
  fieldname: string;
  filename: string;
  buffer: Buffer;
}

/**
 * Papel que um arquivo desempenha, detectado pela ASSINATURA DE COLUNAS —
 * nunca pelo nome do arquivo (os exports reais chegam com nomes variados:
 * "pecas-localizacao.xlsx", "Backup Pecas - 704.xlsx", etc.).
 */
export type DetectedKind =
  | "VAAPT_PECAS" // arquivo-ponte Vaapt: "# Cod Peca" + "Localizacao" (+ "Cod Veiculo")
  | "VAAPT_CLIENTES" // "# Cod Cliente" + "Nome Cliente" + "TipoPessoa"
  // "# Codigo Veiculo" + ≥2 atributos de veículo. Há DUAS variantes reais do
  // mesmo relatório: a clássica ("Marca/Modelo/Chassi/…") e a de imagens
  // ("Placa/numero motor/Numero chassi/Renavam/valor_compra/data_compra",
  // uma linha por foto). Exigir Marca+Modelo deixava a 2ª como DESCONHECIDO.
  | "VAAPT_VEICULOS"
  | "VAAPT_NFE" // resumo invoicy (aba "Java Books", rótulos deslocados)
  // Fotos das peças ("# idPeca" + "Link das imagens"): uma linha por FOTO,
  // com a peça repetida. "# idPeca" == "# Cod Peca" da planilha de peças, que
  // é o SKU do produto no Dexo.
  | "VAAPT_PECAS_IMAGENS"
  | "WD_LOCATIONS" // locations.csv (Id/Initials/InitialsPath/ParentId/Level)
  | "WD_PURCHASE_WASTE" // purchase_waste.csv (sucatas)
  | "WD_PRODUCTS" // products.csv (Code/LocationId/PurchaseWasteId) — arquivo-ponte IBR
  | "WD_CUSTOMERS" // customers.csv (Name/Document/Type)
  | "DEXO_CONTAS" // template CSV Dexo de contas a pagar/receber
  | "IBR_ESTOQUE" // estoque.csv (SKU + localização em texto hierárquico)
  | "IBR_NFE" // nfe_emitidas.csv (chave/série/número/destinatário/status)
  // IBR Soft completo (CSV ";", colunas PT snake_case):
  | "IBRSOFT_PRODUTOS" // produtos.csv (codigo=SKU, sigla_localizacao, placa/lote)
  | "IBRSOFT_SUCATAS" // sucatas.csv (codigo_sequencial, placa, chassi, valor_compra)
  | "IBRSOFT_LOCALIZACOES" // localizacoes.csv (sigla, caminho_siglas, id_pai)
  | "IBRSOFT_CLIENTES" // costumers.csv (nome_razao_social, cpf_cnpj, tipo)
  | "IBRSOFT_NFE" // nfe.csv (numero_nota, chave_acesso, destinatario, status)
  | "IBRSOFT_CONTAS_PAGAR" // contas_a_pagar.csv (favorecido, valor_inicial)
  | "IBRSOFT_CONTAS_RECEBER" // contas_a_receber.csv (cliente, valor_recebido)
  | "DESCONHECIDO";

/** Linha crua parseada (célula pode vir number/string/null do xlsx). */
export type ImportRow = Record<string, unknown>;

export interface DetectedFile extends ImportFile {
  kind: DetectedKind;
  /**
   * Rótulos de coluna como vieram no arquivo. Serve para (a) diagnosticar um
   * arquivo não reconhecido sem precisar do arquivo em mãos e (b) mappers
   * distinguirem "coluna ausente" de "célula vazia".
   */
  header: string[];
  rows: ImportRow[];
  /** Getter tolerante a acento/caixa/pontuação (rótulo → valor da célula). */
  get: (row: ImportRow, label: string) => unknown;
}

export interface ImportRowIssue {
  /** 1-based, na ordem das linhas de DADOS do arquivo. */
  linha?: number;
  motivo: string;
  dados?: unknown;
}

/** Caps de segurança: contadores são sempre completos; listas são amostras. */
export const MAX_ISSUES = 200;
export const MAX_SAMPLE = 20;
export const MAX_EXAMPLES = 200;

export interface ImportReport {
  system: ImportSystem;
  entity: ImportEntity;
  targetUserId: string;
  dryRun: boolean;
  /** Contadores completos (criadas/puladas/erros/avisos, por motivo). */
  contadores: Record<string, number>;
  erros: ImportRowIssue[];
  avisos: ImportRowIssue[];
  /** Amostra de linhas mapeadas (só informativa; cap MAX_SAMPLE). */
  amostra: Array<Record<string, unknown>>;
  /** SKUs do arquivo sem produto correspondente (decisão: pular e reportar). */
  semProduto?: { total: number; exemplos: string[] };
  /** SKUs que casam MAIS de um produto (skuNormalized igual) — nunca vincula. */
  ambiguos?: {
    total: number;
    exemplos: Array<{ sku: string; produtoIds: string[] }>;
  };
  /** Só no modo PACOTE (WebDesmonte): relatório por fase, na ordem executada. */
  porFase?: Record<string, ImportReport>;
  /**
   * Arquivos enviados que o motor NÃO usou. Vive no relatório (e não só nas
   * dicas da prévia) porque o apply roda assíncrono e o operador só vê o
   * relatório final — sem isto, um arquivo válido descartado passa batido.
   */
  ignorados?: IgnoredFileInfo[];
}

export interface IgnoredFileInfo {
  arquivo: string;
  motivo: string;
}

export interface PreviewFileInfo {
  campo: string;
  nome: string;
  linhas: number;
  tipo: DetectedKind;
}

export interface PreviewResult {
  system: ImportSystem;
  entity: ImportEntity;
  targetUserId: string;
  /** Liga a prévia ao apply: sha256(bytes+target+system+entity+versão do motor). */
  previewHash: string;
  arquivos: PreviewFileInfo[];
  dicas: string[];
  report: ImportReport;
}

export type ImportJobState = "RUNNING" | "DONE" | "ERROR" | "INTERROMPIDO";

export interface ImportJobProgress {
  fase: string;
  processadas: number;
  total: number;
}

/** Payload persistido em SystemLog.details (carrier do job — zero migração). */
export interface ImportJobDetails {
  kind: "IMPORT_JOB";
  /** "INTERROMPIDO" nunca é gravado — é derivado no GET via stale-check. */
  status: "RUNNING" | "DONE" | "ERROR";
  targetUserId: string;
  system: ImportSystem;
  entity: ImportEntity;
  previewHash: string;
  progress: ImportJobProgress;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  report?: ImportReport;
  error?: string;
}

export interface ImportJobStatus extends Omit<ImportJobDetails, "kind" | "status"> {
  jobId: string;
  status: ImportJobState;
}

/** Contexto passado aos executors — mesmo shape no preview e no apply. */
export interface ImportContext {
  targetUserId: string;
  files: DetectedFile[];
  dryRun: boolean;
  onProgress?: (p: ImportJobProgress) => void;
}

/** Erro de validação de entrada (vira 400 na rota). */
export class ImportValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

/** Conflito (prévia desatualizada / job já em andamento) — vira 409 na rota. */
export class ImportConflictError extends Error {
  statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ImportConflictError";
  }
}

/* ------------------------- helpers de relatório ------------------------- */

export function newReport(
  system: ImportSystem,
  entity: ImportEntity,
  targetUserId: string,
  dryRun: boolean,
): ImportReport {
  return {
    system,
    entity,
    targetUserId,
    dryRun,
    contadores: {},
    erros: [],
    avisos: [],
    amostra: [],
  };
}

export function bump(
  report: ImportReport,
  key: string,
  delta = 1,
): void {
  report.contadores[key] = (report.contadores[key] ?? 0) + delta;
}

/** Conta SEMPRE; anexa o detalhe só até o cap (listas são amostras). */
export function addIssue(
  list: ImportRowIssue[],
  issue: ImportRowIssue,
  cap = MAX_ISSUES,
): void {
  if (list.length < cap) list.push(issue);
}

export function addSample(
  report: ImportReport,
  sample: Record<string, unknown>,
): void {
  if (report.amostra.length < MAX_SAMPLE) report.amostra.push(sample);
}
