/**
 * Contrato HTTP CONGELADO da NF-e de devolução (plano §6.3) — o MESMO arquivo é
 * usado pelas rotas (backend) e pelo cliente do wizard (front).
 *
 * | Rota                                          | Corpo                        | Resposta |
 * |-----------------------------------------------|------------------------------|----------|
 * | POST /fiscal/nfe/:id/devolucao (id = original) | CriarDevolucaoBody           | 201/200 CriarDevolucaoResposta |
 * | GET  /fiscal/nfe/:id/devolucao/saldo           | —                            | SaldoResposta |
 * | GET  /fiscal/nfe/draft/:id/devolucao           | —                            | DevolucaoDetalhe |
 * | PUT  /fiscal/nfe/draft/:id/devolucao           | AtualizarCabecalhoBody       | DevolucaoDetalhe |
 * | PUT  /fiscal/nfe/draft/:id/devolucao/itens     | AtualizarItensBody           | DevolucaoDetalhe |
 * | POST /fiscal/nfe/devolucao/manual              | ManualBody                   | 201 ManualResposta |
 *
 * Erros: `ErroDevolucaoResposta` com `code` ∈ DEVOLUCAO_ERRO_CODIGOS e o HTTP de
 * `DEVOLUCAO_ERRO_HTTP`. Feature desligada para a config ⇒ 404 sem `code`.
 *
 * Validadores sem zod (`parse*`): devolvem `{ ok, value }` ou `{ ok:false, erros }`
 * e descartam chaves desconhecidas.
 *
 * Módulo PURO — seguro para backend, testes e client.
 */

import { UF_POR_CUF, parseChaveAcesso, validarChaveAcesso } from "../domain/chave-acesso-dv";
import type { StatusMapeamentoCfop } from "../domain/devolucao-cfop";
import type { NfeStatus } from "../domain/nfe.types";
import { temAteQuatroCasas } from "./saldo";
import type {
  DevolucaoIssue,
  EscopoDevolucao,
  FonteDevolucao,
  IdDest,
  IndFinalDevolucao,
  ModoReferenciaDevolucao,
  ReferenciaImpostoOriginal,
  RegimeEmitenteDevolucao,
  SaldoItemOriginal,
  TipoDevolucao,
  TotaisDevolucao,
  TributacaoDevolucaoItem,
  TributacaoOverride,
} from "./tipos";

// ─────────────────────────────── códigos de erro ───────────────────────────────

export const DEVOLUCAO_ERRO_CODIGOS = [
  "PAYLOAD_INVALIDO",
  "NAO_ENCONTRADA",
  "CANCELADA",
  "NAO_AUTORIZADA",
  "SEM_XML",
  "TOTALMENTE_DEVOLVIDA",
  "PARCIALMENTE_DEVOLVIDA",
  "EXIGE_NUMERACAO_V2",
  "RECUSA_NAO_E_DEVOLUCAO",
  "EMITENTE_ORIGINAL_AUSENTE",
  "MODELO_NAO_SUPORTADO",
  "ORIGINAL_ENTRADA",
  "JA_E_DEVOLUCAO",
  "AMBIENTE_DIVERGENTE",
  "DEVOLUCAO_NAO_GERENCIADA",
  "DEVOLUCAO_EM_EMISSAO",
  "ITEM_ORIGINAL_INEXISTENTE",
  "CFOP_INVALIDO",
  "TRIBUTACAO_NAO_SUPORTADA",
  "SALDO_INSUFICIENTE",
  "RASCUNHO_ALTERADO",
  "XML_INVALIDO",
  "XML_SEM_AUTORIZACAO",
  "CHAVE_INVALIDA",
  "NOTA_NAO_EMITIDA_PARA_ESTE_CNPJ",
  "CONFIRMACAO_SEM_XML_OBRIGATORIA",
  "ORIGINAL_COM_DEVOLUCAO",
  "DEVOLUCAO_INVALIDA",
] as const;

export type DevolucaoErroCodigo = (typeof DEVOLUCAO_ERRO_CODIGOS)[number];

export const DEVOLUCAO_ERRO_HTTP: Readonly<Record<DevolucaoErroCodigo, 400 | 404 | 409 | 422>> = {
  PAYLOAD_INVALIDO: 400,
  NAO_ENCONTRADA: 404,
  CANCELADA: 409,
  NAO_AUTORIZADA: 409,
  SEM_XML: 409,
  TOTALMENTE_DEVOLVIDA: 409,
  PARCIALMENTE_DEVOLVIDA: 409,
  EXIGE_NUMERACAO_V2: 422,
  RECUSA_NAO_E_DEVOLUCAO: 422,
  EMITENTE_ORIGINAL_AUSENTE: 409,
  MODELO_NAO_SUPORTADO: 422,
  ORIGINAL_ENTRADA: 422,
  JA_E_DEVOLUCAO: 422,
  AMBIENTE_DIVERGENTE: 422,
  DEVOLUCAO_NAO_GERENCIADA: 404,
  DEVOLUCAO_EM_EMISSAO: 409,
  ITEM_ORIGINAL_INEXISTENTE: 422,
  CFOP_INVALIDO: 422,
  TRIBUTACAO_NAO_SUPORTADA: 422,
  SALDO_INSUFICIENTE: 409,
  RASCUNHO_ALTERADO: 409,
  XML_INVALIDO: 422,
  XML_SEM_AUTORIZACAO: 422,
  CHAVE_INVALIDA: 422,
  NOTA_NAO_EMITIDA_PARA_ESTE_CNPJ: 422,
  CONFIRMACAO_SEM_XML_OBRIGATORIA: 422,
  ORIGINAL_COM_DEVOLUCAO: 409,
  DEVOLUCAO_INVALIDA: 422,
};

export const DEVOLUCAO_ERRO_MENSAGEM: Readonly<Record<DevolucaoErroCodigo, string>> = {
  PAYLOAD_INVALIDO: "Dados da requisição inválidos.",
  NAO_ENCONTRADA: "Nota não encontrada.",
  CANCELADA: "Nota cancelada — não há o que devolver.",
  NAO_AUTORIZADA: "Só notas autorizadas pela SEFAZ podem ser devolvidas.",
  SEM_XML: "Nota sem XML autorizado no Dexo — use a devolução manual.",
  TOTALMENTE_DEVOLVIDA: "Todos os itens desta nota já foram devolvidos.",
  PARCIALMENTE_DEVOLVIDA: "Esta nota já foi parcialmente devolvida — use a devolução parcial.",
  EXIGE_NUMERACAO_V2: "Devolução exige a numeração v2 habilitada para esta empresa.",
  RECUSA_NAO_E_DEVOLUCAO: "Recusa ou não entrega não é devolução (finNFe 5) — fora deste fluxo.",
  EMITENTE_ORIGINAL_AUSENTE: "O CNPJ que emitiu a nota original não está configurado nesta conta.",
  MODELO_NAO_SUPORTADO: "Só NF-e (55) e NFC-e (65) podem ser devolvidas.",
  ORIGINAL_ENTRADA: "Nota de entrada — devolução de compra usa a devolução manual.",
  JA_E_DEVOLUCAO: "Esta já é uma nota de devolução.",
  AMBIENTE_DIVERGENTE: "A nota original e o emissor estão em ambientes diferentes (homologação × produção).",
  DEVOLUCAO_NAO_GERENCIADA: "Este rascunho não é uma devolução gerenciada.",
  DEVOLUCAO_EM_EMISSAO: "Esta nota já foi enviada à SEFAZ e não pode mais ser alterada.",
  ITEM_ORIGINAL_INEXISTENTE: "O item informado não existe na nota original.",
  CFOP_INVALIDO: "CFOP inválido para esta devolução.",
  TRIBUTACAO_NAO_SUPORTADA: "Tributação não suportada na devolução.",
  SALDO_INSUFICIENTE: "Quantidade maior que o saldo disponível para devolução.",
  RASCUNHO_ALTERADO: "A devolução foi alterada durante a emissão — tente novamente.",
  XML_INVALIDO: "XML da nota original inválido.",
  XML_SEM_AUTORIZACAO: "XML sem protocolo de autorização.",
  CHAVE_INVALIDA: "Chave de acesso inválida.",
  NOTA_NAO_EMITIDA_PARA_ESTE_CNPJ: "A nota não foi emitida para este CNPJ.",
  CONFIRMACAO_SEM_XML_OBRIGATORIA: "Sem o XML da nota original, confirme a devolução sem XML.",
  ORIGINAL_COM_DEVOLUCAO: "A nota tem devolução autorizada ou em envio — cancele a devolução antes.",
  DEVOLUCAO_INVALIDA: "A devolução tem pendências que impedem a emissão.",
};

export function isDevolucaoErroCodigo(v: unknown): v is DevolucaoErroCodigo {
  return typeof v === "string" && (DEVOLUCAO_ERRO_CODIGOS as readonly string[]).includes(v);
}

export interface ErroCampo {
  campo: string;
  mensagem: string;
}

export interface ErroDevolucaoResposta {
  error: string;
  code: DevolucaoErroCodigo;
  issues?: DevolucaoIssue[];
  erros?: ErroCampo[];
  /** Presente quando o erro diz respeito a um rascunho existente. */
  draftId?: string;
}

export function respostaErroDevolucao(
  code: DevolucaoErroCodigo,
  extras?: { mensagem?: string; issues?: DevolucaoIssue[]; erros?: ErroCampo[]; draftId?: string },
): { status: 400 | 404 | 409 | 422; body: ErroDevolucaoResposta } {
  const body: ErroDevolucaoResposta = { error: extras?.mensagem ?? DEVOLUCAO_ERRO_MENSAGEM[code], code };
  if (extras?.issues) body.issues = extras.issues;
  if (extras?.erros) body.erros = extras.erros;
  if (extras?.draftId) body.draftId = extras.draftId;
  return { status: DEVOLUCAO_ERRO_HTTP[code], body };
}

// ─────────────────────────────── corpos e respostas ───────────────────────────────

export interface CriarDevolucaoBody {
  escopo?: EscopoDevolucao;
}

/** 201 com reutilizado=false; 200 com reutilizado=true (já havia devolução aberta desta original). */
export interface CriarDevolucaoResposta {
  draftId: string;
  reutilizado: boolean;
}

export interface SaldoItemResposta extends SaldoItemOriginal {
  codigo: string;
  descricao: string;
  unidade: string;
  valorUnitario: number | null;
}

export interface DevolucaoVinculadaResumo {
  nfeId: string;
  /** null enquanto rascunho (placeholder negativo não é número fiscal). */
  numero: number | null;
  serie: number;
  status: NfeStatus;
  itens: Array<{ nItem: number; quantidade: number }>;
}

export interface SaldoResposta {
  original: {
    nfeId: string;
    chaveAcesso: string;
    /** nº e série REAIS, lidos da chave. */
    numero: number;
    serie: number;
    modelo: string;
    status: NfeStatus;
    dataEmissao: string | null;
    destinatarioNome: string | null;
    destinatarioCpfCnpj: string | null;
  };
  elegivel: boolean;
  motivo: DevolucaoErroCodigo | null;
  itens: SaldoItemResposta[];
  devolucoes: DevolucaoVinculadaResumo[];
  totalmenteDevolvida: boolean;
}

export interface OrigemResumo {
  chaveAcesso: string;
  originalNfeId: string | null;
  modelo: string;
  numero: number;
  serie: number;
  dataEmissao: string | null;
  destinatarioNome: string | null;
}

export interface DevolucaoItemDetalhe {
  ordem: number;
  chaveAcesso: string;
  nItem: number;
  codigo: string;
  descricao: string;
  unidade: string;
  ncm: string;
  quantidadeOriginal: number | null;
  devolvidaAutorizada: number;
  emProcessamento: number;
  disponivel: number | null;
  quantidade: number;
  valorUnitario: number;
  valor: number;
  cfopOriginal: string | null;
  cfop: string;
  cfopStatus: StatusMapeamentoCfop;
  cfopOpcoes: string[];
  tributacao: TributacaoDevolucaoItem;
  requerRevisao: boolean;
  /**
   * O imposto da nota ORIGINAL deste item, na proporção devolvida, com a frase
   * pronta para a tela ("Na nota do fornecedor: CST 00 · base R$ 123,56 · 12% ·
   * ICMS R$ 14,83"). Sai de `referenciaImpostoOriginal` (tributacao.ts). `null` =
   * devolução manual sem XML (não há imposto original para conferir).
   * Opcional: servidor antigo não manda.
   */
  referenciaOriginal?: ReferenciaImpostoOriginal | null;
}

export interface DevolucaoDetalhe {
  draftId: string;
  status: NfeStatus;
  tipo: TipoDevolucao;
  fonte: FonteDevolucao;
  escopo: EscopoDevolucao;
  /** null na criação; a emissão exige true. */
  devolvidaAposEntrega: boolean | null;
  confirmadoSemXml: boolean;
  indFinal: IndFinalDevolucao;
  modoReferencia: ModoReferenciaDevolucao;
  /**
   * Regime do emitente DESTA devolução e os códigos de ICMS que ele pode usar
   * (`regimeEmitenteDevolucao`). É o que deixa o campo de ICMS recusar CST no
   * Simples — e CSOSN no regime normal — na hora, em vez de deixar salvar e
   * travar na emissão com a rejeição 591.
   */
  emitente: RegimeEmitenteDevolucao;
  originais: OrigemResumo[];
  itens: DevolucaoItemDetalhe[];
  /** Prévia de validarDevolucao. */
  issues: DevolucaoIssue[];
  podeEmitir: boolean;
  /**
   * Totais que a emissão vai calcular (`totaisDevolucao`, a MESMA função de
   * `calcularDevolucao`): ICMS, PIS, COFINS, IPI devolvido e o valor da nota
   * (produtos − desconto + frete + IPI devolvido). `completo:false` = prévia com
   * itens ainda por fechar (`itensPendentes`). Opcional: servidor antigo não manda.
   */
  totais?: TotaisDevolucao;
}

export interface AtualizarCabecalhoBody {
  devolvidaAposEntrega?: boolean | null;
  escopo?: EscopoDevolucao;
  tipo?: TipoDevolucao;
}

export interface AtualizarItemBody {
  chaveAcesso: string;
  nItem: number;
  quantidade: number;
  cfop: string;
  tributacao?: TributacaoOverride;
  confirmarTributacao?: boolean;
}

/** Substitui a lista inteira (único gravador dos itens de devolução gerenciada). */
export interface AtualizarItensBody {
  itens: AtualizarItemBody[];
}

export interface ManualItemBody {
  nItem: number;
  codigo: string;
  descricao: string;
  ncm: string;
  cest?: string | null;
  unidade: string;
  origem?: number | null;
  cfopOriginal?: string | null;
  cfop?: string | null;
  quantidadeOriginal?: number | null;
  valorUnitario: number;
  quantidade: number;
}

/** Mesmo formato de NfeDestinatario (campos opcionais: texto ou null). */
export interface ManualDestinatarioBody {
  tipoPessoa: "PF" | "PJ" | "EXTERIOR";
  cpfCnpj: string;
  nome: string;
  inscricaoEstadual?: string | null;
  indicadorIE?: string | null;
  email?: string | null;
  telefone?: string | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  codMunicipio?: string | null;
  uf?: string | null;
  codPais?: string | null;
  pais?: string | null;
}

const CAMPOS_OPCIONAIS_DESTINATARIO = [
  "inscricaoEstadual", "indicadorIE", "email", "telefone", "cep", "logradouro", "numero",
  "complemento", "bairro", "municipio", "codMunicipio", "uf", "codPais", "pais",
] as const;

/** Corpo na rede: `xmlOriginal` OU `chaveAcesso` + `itens`. */
export interface ManualBody {
  tipo: TipoDevolucao;
  xmlOriginal?: string;
  chaveAcesso?: string;
  itens?: Array<ManualItemBody | { nItem: number; quantidade: number }>;
  confirmarSemXml?: boolean;
  companyFiscalConfigId?: string | null;
  devolvidaAposEntrega?: boolean | null;
  escopo?: EscopoDevolucao;
  destinatario?: ManualDestinatarioBody | null;
}

interface ManualValidadoBase {
  tipo: TipoDevolucao;
  companyFiscalConfigId: string | null;
  devolvidaAposEntrega: boolean | null;
  escopo: EscopoDevolucao | null;
}

export interface ManualValidadoXml extends ManualValidadoBase {
  modo: "XML";
  xmlOriginal: string;
  confirmarSemXml: boolean;
  /** Seleção opcional por nItem do XML; ausente = todos com saldo. */
  itens: Array<{ nItem: number; quantidade: number }> | null;
}

export interface ManualValidadoChave extends ManualValidadoBase {
  modo: "CHAVE";
  chaveAcesso: string;
  itens: ManualItemBody[];
  confirmarSemXml: true;
  destinatario: ManualDestinatarioBody | null;
}

export type ManualValidado = ManualValidadoXml | ManualValidadoChave;

export interface ManualResposta {
  draftId: string;
}

// ─────────────────────────────── validadores ───────────────────────────────

export type ResultadoParse<T> = { ok: true; value: T } | { ok: false; erros: ErroCampo[] };

/** Teto do XML em texto (1 MiB). */
export const DEVOLUCAO_XML_MAX_CARACTERES = 1_048_576;
export const DEVOLUCAO_MAX_ITENS = 990;
const QUANTIDADE_MAX = 999_999_999;

const ESCOPOS: readonly EscopoDevolucao[] = ["TOTAL", "PARCIAL"];
const TIPOS: readonly TipoDevolucao[] = ["VENDA_ENTRADA", "COMPRA_SAIDA"];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Corpo ausente (Fastify sem body) conta como objeto vazio. */
function corpo(raw: unknown, erros: ErroCampo[]): Obj | null {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) {
    erros.push({ campo: "", mensagem: "O corpo precisa ser um objeto JSON." });
    return null;
  }
  return raw;
}

function lerEnum<T extends string>(
  o: Obj,
  campo: string,
  valores: readonly T[],
  erros: ErroCampo[],
  prefixo = "",
): T | undefined {
  const v = o[campo];
  if (v === undefined) return undefined;
  if (typeof v === "string" && (valores as readonly string[]).includes(v)) return v as T;
  erros.push({ campo: prefixo + campo, mensagem: `Use um de: ${valores.join(", ")}.` });
  return undefined;
}

function lerBooleano(o: Obj, campo: string, erros: ErroCampo[], aceitaNull: boolean, prefixo = ""): boolean | null | undefined {
  const v = o[campo];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  if (v === null && aceitaNull) return null;
  erros.push({ campo: prefixo + campo, mensagem: "Informe verdadeiro ou falso." });
  return undefined;
}

function lerNumero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

function lerQuantidade(v: unknown, campo: string, erros: ErroCampo[]): number | null {
  const n = lerNumero(v);
  if (n === null || n <= 0 || n > QUANTIDADE_MAX) {
    erros.push({ campo, mensagem: "A quantidade precisa ser maior que zero." });
    return null;
  }
  if (!temAteQuatroCasas(typeof v === "string" ? v.trim() : n)) {
    erros.push({ campo, mensagem: "Use no máximo 4 casas decimais." });
    return null;
  }
  return n;
}

function lerNItem(v: unknown, campo: string, erros: ErroCampo[]): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 990) return v;
  erros.push({ campo, mensagem: "O número do item da nota original vai de 1 a 990." });
  return null;
}

function lerChave(v: unknown, campo: string, erros: ErroCampo[]): string | null {
  const r = validarChaveAcesso(v);
  if (r.ok) return r.chave;
  erros.push({ campo, mensagem: r.mensagem });
  return null;
}

function lerTexto(v: unknown, campo: string, erros: ErroCampo[], max: number, obrigatorio: boolean): string | null {
  if (v === undefined || v === null) {
    if (obrigatorio) erros.push({ campo, mensagem: "Campo obrigatório." });
    return null;
  }
  if (typeof v !== "string" || (obrigatorio && v.trim() === "") || v.length > max) {
    erros.push({ campo, mensagem: obrigatorio ? "Campo obrigatório." : "Texto inválido." });
    return null;
  }
  return v.trim();
}

function lerTributacaoOverride(v: unknown, campo: string, erros: ErroCampo[]): TributacaoOverride | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) {
    erros.push({ campo, mensagem: "Tributação inválida." });
    return undefined;
  }
  const out: TributacaoOverride = {};
  const codigo = (x: unknown, tam: number, c: string): string | null | undefined => {
    if (x === undefined) return undefined;
    if (x === null) return null;
    if (typeof x === "string" && new RegExp(`^\\d{${tam}}$`).test(x)) return x;
    erros.push({ campo: c, mensagem: `Use ${tam} dígitos.` });
    return undefined;
  };
  const aliquota = (x: unknown, c: string): number | null | undefined => {
    if (x === undefined) return undefined;
    if (x === null) return null;
    if (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100) return x;
    erros.push({ campo: c, mensagem: "A alíquota deve estar entre 0 e 100." });
    return undefined;
  };
  if (v.icms !== undefined) {
    if (!isObj(v.icms)) {
      erros.push({ campo: `${campo}.icms`, mensagem: "ICMS inválido." });
    } else {
      const icms: NonNullable<TributacaoOverride["icms"]> = {};
      const cst = codigo(v.icms.cst, 2, `${campo}.icms.cst`);
      if (cst !== undefined) icms.cst = cst;
      const csosn = codigo(v.icms.csosn, 3, `${campo}.icms.csosn`);
      if (csosn !== undefined) icms.csosn = csosn;
      const modBC = codigo(v.icms.modBC, 1, `${campo}.icms.modBC`);
      if (modBC !== undefined) icms.modBC = modBC;
      const p = aliquota(v.icms.pICMS, `${campo}.icms.pICMS`);
      if (p !== undefined) icms.pICMS = p;
      if (icms.cst && icms.csosn) {
        erros.push({ campo: `${campo}.icms`, mensagem: "Informe CST ou CSOSN, não os dois." });
      }
      out.icms = icms;
    }
  }
  for (const qual of ["pis", "cofins"] as const) {
    const x = v[qual];
    if (x === undefined) continue;
    if (!isObj(x)) {
      erros.push({ campo: `${campo}.${qual}`, mensagem: "Tributo inválido." });
      continue;
    }
    const t: { cst?: string | null; p?: number | null } = {};
    const cst = codigo(x.cst, 2, `${campo}.${qual}.cst`);
    if (cst !== undefined) t.cst = cst;
    const p = aliquota(x.p, `${campo}.${qual}.p`);
    if (p !== undefined) t.p = p;
    out[qual] = t;
  }
  if (v.ipiDevol !== undefined) {
    if (typeof v.ipiDevol === "boolean") out.ipiDevol = v.ipiDevol;
    else erros.push({ campo: `${campo}.ipiDevol`, mensagem: "Informe verdadeiro ou falso." });
  }
  return out;
}

export function parseCriarDevolucaoBody(raw: unknown): ResultadoParse<CriarDevolucaoBody> {
  const erros: ErroCampo[] = [];
  const o = corpo(raw, erros);
  if (!o) return { ok: false, erros };
  const value: CriarDevolucaoBody = {};
  const escopo = lerEnum(o, "escopo", ESCOPOS, erros);
  if (escopo) value.escopo = escopo;
  return erros.length ? { ok: false, erros } : { ok: true, value };
}

export function parseAtualizarCabecalhoBody(raw: unknown): ResultadoParse<AtualizarCabecalhoBody> {
  const erros: ErroCampo[] = [];
  const o = corpo(raw, erros);
  if (!o) return { ok: false, erros };
  const value: AtualizarCabecalhoBody = {};
  const entrega = lerBooleano(o, "devolvidaAposEntrega", erros, true);
  if (entrega !== undefined) value.devolvidaAposEntrega = entrega;
  const escopo = lerEnum(o, "escopo", ESCOPOS, erros);
  if (escopo) value.escopo = escopo;
  const tipo = lerEnum(o, "tipo", TIPOS, erros);
  if (tipo) value.tipo = tipo;
  return erros.length ? { ok: false, erros } : { ok: true, value };
}

export function parseAtualizarItensBody(raw: unknown): ResultadoParse<AtualizarItensBody> {
  const erros: ErroCampo[] = [];
  const o = corpo(raw, erros);
  if (!o) return { ok: false, erros };
  if (!Array.isArray(o.itens)) {
    return { ok: false, erros: [{ campo: "itens", mensagem: "Informe a lista de itens." }] };
  }
  if (o.itens.length === 0) {
    return { ok: false, erros: [{ campo: "itens", mensagem: "Escolha pelo menos um item para devolver." }] };
  }
  if (o.itens.length > DEVOLUCAO_MAX_ITENS) {
    return { ok: false, erros: [{ campo: "itens", mensagem: `No máximo ${DEVOLUCAO_MAX_ITENS} itens.` }] };
  }
  const itens: AtualizarItemBody[] = [];
  const pares = new Set<string>();
  o.itens.forEach((bruto, i) => {
    const p = `itens[${i}].`;
    if (!isObj(bruto)) {
      erros.push({ campo: `itens[${i}]`, mensagem: "Item inválido." });
      return;
    }
    const antes = erros.length;
    const chave = lerChave(bruto.chaveAcesso, p + "chaveAcesso", erros);
    const nItem = lerNItem(bruto.nItem, p + "nItem", erros);
    const quantidade = lerQuantidade(bruto.quantidade, p + "quantidade", erros);
    const cfop = typeof bruto.cfop === "string" && /^\d{4}$/.test(bruto.cfop.trim()) ? bruto.cfop.trim() : null;
    if (cfop === null) erros.push({ campo: p + "cfop", mensagem: "Escolha o CFOP de devolução (4 dígitos)." });
    const tributacao = lerTributacaoOverride(bruto.tributacao, p + "tributacao", erros);
    const confirmar = lerBooleano(bruto, "confirmarTributacao", erros, false, p);
    if (erros.length > antes || chave === null || nItem === null || quantidade === null || cfop === null) return;
    const par = `${chave}#${nItem}`;
    if (pares.has(par)) {
      erros.push({ campo: `itens[${i}]`, mensagem: "O mesmo item da nota original aparece mais de uma vez (Rejeição 1072)." });
      return;
    }
    pares.add(par);
    const item: AtualizarItemBody = { chaveAcesso: chave, nItem, quantidade, cfop };
    if (tributacao) item.tributacao = tributacao;
    if (typeof confirmar === "boolean") item.confirmarTributacao = confirmar;
    itens.push(item);
  });
  return erros.length ? { ok: false, erros } : { ok: true, value: { itens } };
}

export function parseManualBody(raw: unknown): ResultadoParse<ManualValidado> {
  const erros: ErroCampo[] = [];
  const o = corpo(raw, erros);
  if (!o) return { ok: false, erros };

  const tipo = lerEnum(o, "tipo", TIPOS, erros);
  if (o.tipo === undefined) erros.push({ campo: "tipo", mensagem: "Informe o tipo de devolução." });
  const escopo = lerEnum(o, "escopo", ESCOPOS, erros) ?? null;
  const entrega = lerBooleano(o, "devolvidaAposEntrega", erros, true);
  const confirmar = lerBooleano(o, "confirmarSemXml", erros, false);
  let companyFiscalConfigId: string | null = null;
  if (o.companyFiscalConfigId !== undefined && o.companyFiscalConfigId !== null) {
    companyFiscalConfigId = lerTexto(o.companyFiscalConfigId, "companyFiscalConfigId", erros, 64, true);
  }

  const temXml = o.xmlOriginal !== undefined && o.xmlOriginal !== null;
  const temChave = o.chaveAcesso !== undefined && o.chaveAcesso !== null;
  if (temXml === temChave) {
    erros.push({
      campo: temXml ? "xmlOriginal" : "chaveAcesso",
      mensagem: temXml
        ? "Informe o XML da nota original OU a chave com os itens, não os dois."
        : "Informe o XML da nota original ou a chave de acesso com os itens.",
    });
    return { ok: false, erros };
  }

  const base = {
    tipo: tipo as TipoDevolucao,
    companyFiscalConfigId,
    devolvidaAposEntrega: entrega === undefined ? null : entrega,
    escopo,
  };

  if (temXml) {
    const xml = o.xmlOriginal;
    if (typeof xml !== "string" || xml.trim() === "") {
      erros.push({ campo: "xmlOriginal", mensagem: "XML vazio." });
    } else if (xml.length > DEVOLUCAO_XML_MAX_CARACTERES) {
      erros.push({ campo: "xmlOriginal", mensagem: "XML maior que 1 MB." });
    }
    let itens: Array<{ nItem: number; quantidade: number }> | null = null;
    if (o.itens !== undefined && o.itens !== null) {
      if (!Array.isArray(o.itens) || o.itens.length === 0 || o.itens.length > DEVOLUCAO_MAX_ITENS) {
        erros.push({ campo: "itens", mensagem: "Seleção de itens inválida." });
      } else {
        itens = [];
        const vistos = new Set<number>();
        o.itens.forEach((b, i) => {
          if (!isObj(b)) {
            erros.push({ campo: `itens[${i}]`, mensagem: "Item inválido." });
            return;
          }
          const nItem = lerNItem(b.nItem, `itens[${i}].nItem`, erros);
          const quantidade = lerQuantidade(b.quantidade, `itens[${i}].quantidade`, erros);
          if (nItem === null || quantidade === null) return;
          if (vistos.has(nItem)) {
            erros.push({ campo: `itens[${i}]`, mensagem: "Item repetido (Rejeição 1072)." });
            return;
          }
          vistos.add(nItem);
          itens!.push({ nItem, quantidade });
        });
      }
    }
    if (erros.length) return { ok: false, erros };
    return {
      ok: true,
      value: { ...base, modo: "XML", xmlOriginal: xml as string, confirmarSemXml: confirmar === true, itens },
    };
  }

  // modo CHAVE: sem XML ⇒ confirmação explícita obrigatória (saldo não verificável)
  const chave = lerChave(o.chaveAcesso, "chaveAcesso", erros);
  if (confirmar !== true) {
    erros.push({
      campo: "confirmarSemXml",
      mensagem: "Sem o XML da nota original, confirme a devolução sem XML.",
    });
  }
  const itens: ManualItemBody[] = [];
  if (!Array.isArray(o.itens) || o.itens.length === 0) {
    erros.push({ campo: "itens", mensagem: "Informe os itens devolvidos." });
  } else if (o.itens.length > DEVOLUCAO_MAX_ITENS) {
    erros.push({ campo: "itens", mensagem: `No máximo ${DEVOLUCAO_MAX_ITENS} itens.` });
  } else {
    const vistos = new Set<number>();
    o.itens.forEach((b, i) => {
      const p = `itens[${i}].`;
      if (!isObj(b)) {
        erros.push({ campo: `itens[${i}]`, mensagem: "Item inválido." });
        return;
      }
      const antes = erros.length;
      const nItem = lerNItem(b.nItem, p + "nItem", erros);
      const codigo = lerTexto(b.codigo, p + "codigo", erros, 60, true);
      const descricao = lerTexto(b.descricao, p + "descricao", erros, 120, true);
      const ncm = typeof b.ncm === "string" && /^\d{8}$/.test(b.ncm.trim()) ? b.ncm.trim() : null;
      if (ncm === null) erros.push({ campo: p + "ncm", mensagem: "NCM com 8 dígitos." });
      const unidade = lerTexto(b.unidade, p + "unidade", erros, 6, true);
      const quantidade = lerQuantidade(b.quantidade, p + "quantidade", erros);
      const valorUnitario = lerNumero(b.valorUnitario);
      if (valorUnitario === null || valorUnitario <= 0) {
        erros.push({ campo: p + "valorUnitario", mensagem: "Informe o valor unitário da nota original." });
      }
      let quantidadeOriginal: number | null = null;
      if (b.quantidadeOriginal !== undefined && b.quantidadeOriginal !== null) {
        quantidadeOriginal = lerQuantidade(b.quantidadeOriginal, p + "quantidadeOriginal", erros);
      }
      let origem: number | null = null;
      if (b.origem !== undefined && b.origem !== null) {
        if (typeof b.origem === "number" && Number.isInteger(b.origem) && b.origem >= 0 && b.origem <= 8) origem = b.origem;
        else erros.push({ campo: p + "origem", mensagem: "Origem de 0 a 8." });
      }
      const cfopDe = (x: unknown, c: string): string | null => {
        if (x === undefined || x === null || x === "") return null;
        if (typeof x === "string" && /^\d{4}$/.test(x.trim())) return x.trim();
        erros.push({ campo: c, mensagem: "CFOP com 4 dígitos." });
        return null;
      };
      const cfopOriginal = cfopDe(b.cfopOriginal, p + "cfopOriginal");
      const cfop = cfopDe(b.cfop, p + "cfop");
      let cest: string | null = null;
      if (b.cest !== undefined && b.cest !== null && b.cest !== "") {
        if (typeof b.cest === "string" && /^\d{7}$/.test(b.cest.trim())) cest = b.cest.trim();
        else erros.push({ campo: p + "cest", mensagem: "CEST com 7 dígitos." });
      }
      if (erros.length > antes || nItem === null || quantidade === null) return;
      if (quantidadeOriginal !== null && quantidade > quantidadeOriginal) {
        erros.push({ campo: p + "quantidade", mensagem: "Quantidade maior que a da nota original." });
        return;
      }
      if (vistos.has(nItem)) {
        erros.push({ campo: `itens[${i}]`, mensagem: "Item repetido (Rejeição 1072)." });
        return;
      }
      vistos.add(nItem);
      itens.push({
        nItem,
        codigo: codigo as string,
        descricao: descricao as string,
        ncm: ncm as string,
        cest,
        unidade: unidade as string,
        origem,
        cfopOriginal,
        cfop,
        quantidadeOriginal,
        valorUnitario: valorUnitario as number,
        quantidade,
      });
    });
  }

  let destinatario: ManualDestinatarioBody | null = null;
  if (o.destinatario !== undefined && o.destinatario !== null) {
    const d = o.destinatario;
    if (
      !isObj(d) ||
      !["PF", "PJ", "EXTERIOR"].includes(String(d.tipoPessoa)) ||
      typeof d.cpfCnpj !== "string" ||
      typeof d.nome !== "string" ||
      d.nome.trim() === ""
    ) {
      erros.push({ campo: "destinatario", mensagem: "Destinatário inválido (tipo de pessoa, CPF/CNPJ e nome)." });
    } else {
      const dest: ManualDestinatarioBody = {
        tipoPessoa: d.tipoPessoa as ManualDestinatarioBody["tipoPessoa"],
        cpfCnpj: d.cpfCnpj.trim(),
        nome: d.nome.trim(),
      };
      for (const campo of CAMPOS_OPCIONAIS_DESTINATARIO) {
        const v = d[campo];
        if (v === undefined) continue;
        if (v === null || (typeof v === "string" && v.length <= 256)) dest[campo] = v === null ? null : v.trim();
        else erros.push({ campo: `destinatario.${campo}`, mensagem: "Texto inválido." });
      }
      // A UF decide o destino da operação (montagem-manual compara com a UF da
      // empresa): "sc" minúsculo virava operação INTERESTADUAL.
      if (typeof dest.uf === "string") dest.uf = dest.uf.toUpperCase();
      destinatario = dest;
    }
  }

  if (destinatario) erros.push(...conferirDestinatarioDaChave(tipo, chave, destinatario));

  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    value: {
      ...base,
      modo: "CHAVE",
      chaveAcesso: chave as string,
      itens,
      confirmarSemXml: true,
      destinatario,
    },
  };
}

// ───────────────────── chave × destinatário × destino (modo CHAVE) ─────────────────────

/** Siglas aceitas na UF do destinatário: as 27 da tabela do cUF (e "EX" para cliente do exterior). */
const UFS_VALIDAS: ReadonlySet<string> = new Set(Object.values(UF_POR_CUF));

function formatarCnpjCpf(doc14: string): string {
  if (doc14.startsWith("000") && !/^0+$/.test(doc14)) {
    const cpf = doc14.slice(3);
    return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
  }
  return `${doc14.slice(0, 2)}.${doc14.slice(2, 5)}.${doc14.slice(5, 8)}/${doc14.slice(8, 12)}-${doc14.slice(12)}`;
}

/**
 * O que dá para conferir SÓ com o corpo: a UF é sigla de verdade e, na
 * devolução de COMPRA, o destinatário é o próprio emitente da chave (mesmo
 * CPF/CNPJ, mesma UF do cUF). Sem isto o erro só aparecia na emissão — Rejeição
 * 1194 (CNPJ) ou 772/773 (destino) —, com o destino já preso no rascunho.
 */
function conferirDestinatarioDaChave(
  tipo: TipoDevolucao | undefined,
  chave: string | null,
  destinatario: Pick<ManualDestinatarioBody, "tipoPessoa" | "cpfCnpj" | "uf">,
): ErroCampo[] {
  const erros: ErroCampo[] = [];
  const uf = (destinatario.uf ?? "").trim().toUpperCase();
  const ufValida = uf === "" || UFS_VALIDAS.has(uf) || (uf === "EX" && destinatario.tipoPessoa === "EXTERIOR");
  if (!ufValida) {
    erros.push({ campo: "destinatario.uf", mensagem: "UF inválida: use a sigla do estado (SC, PR, SP...)." });
  }
  if (tipo !== "COMPRA_SAIDA" || !chave) return erros;
  const partes = parseChaveAcesso(chave);
  if (!partes) return erros;
  const doc = destinatario.cpfCnpj.replace(/\D/g, "");
  if (doc && doc.padStart(14, "0") !== partes.cnpjCpf) {
    erros.push({
      campo: "destinatario.cpfCnpj",
      mensagem: `Na devolução de compra o destinatário é o fornecedor que emitiu a nota: pela chave de acesso, o CPF/CNPJ dele é ${formatarCnpjCpf(partes.cnpjCpf)}.`,
    });
  }
  if (uf && ufValida && partes.uf && uf !== partes.uf) {
    erros.push({
      campo: "destinatario.uf",
      mensagem: `O fornecedor desta chave é de ${partes.uf}: a UF do destinatário tem de ser ${partes.uf}.`,
    });
  }
  return erros;
}

export interface ConferenciaChaveManual {
  /** Recusas com o nome do campo (vão no 400 PAYLOAD_INVALIDO, como as de `parseManualBody`). */
  erros: ErroCampo[];
  /** Destino da operação: 1 interna, 2 interestadual, 3 exterior. null = não deu para saber (há erro dizendo o que falta). */
  idDest: IdDest | null;
  /** UF do destinatário (sigla) que vale para a nota: na devolução de compra, a do cUF da chave. */
  ufDestinatario: string | null;
}

const IDDEST_POR_DIGITO_CFOP: Readonly<Record<string, IdDest>> = { "5": 1, "6": 2, "7": 3 };

/**
 * Confere a chave da devolução manual (modo CHAVE) contra a EMPRESA e deriva o
 * destino da operação — o que `parseManualBody` não consegue sozinho, porque não
 * conhece a config. Para o caso de uso chamar na criação, ANTES de montar o
 * rascunho: depois disso a empresa e o destino ficam presos (origensJson e
 * `destinoOperacao` são protegidos).
 *
 *  - COMPRA_SAIDA: a chave não pode ser da própria empresa; o destino sai do cUF
 *    da chave (a UF do fornecedor) contra a UF da empresa — nunca da UF digitada.
 *  - VENDA_ENTRADA: a chave tem de ser da própria empresa; o destino sai da UF
 *    do cliente ou, sem ela, do 1º dígito do CFOP da venda (5/6/7); os dois
 *    juntos têm de concordar. Cliente do exterior ⇒ 3.
 *
 * Modelo 65 NÃO é recusado: devolução pode referenciar NFC-e.
 */
export function conferirChaveDevolucaoManual(entrada: {
  tipo: TipoDevolucao;
  chaveAcesso: string;
  destinatario: Pick<ManualDestinatarioBody, "tipoPessoa" | "cpfCnpj" | "uf"> | null;
  itens?: ReadonlyArray<{ cfopOriginal?: string | null }>;
  emitente: { cnpj: string; uf: string | null | undefined };
}): ConferenciaChaveManual {
  const erros: ErroCampo[] = [];
  const partes = parseChaveAcesso(entrada.chaveAcesso);
  if (!partes || !partes.dvValido) {
    return { erros: [{ campo: "chaveAcesso", mensagem: "Chave de acesso inválida." }], idDest: null, ufDestinatario: null };
  }
  const cnpjEmitente = entrada.emitente.cnpj.replace(/\D/g, "").padStart(14, "0");
  const ufEmitente = (entrada.emitente.uf ?? "").trim().toUpperCase() || null;
  const ufDigitada = (entrada.destinatario?.uf ?? "").trim().toUpperCase() || null;

  if (entrada.tipo === "COMPRA_SAIDA") {
    if (partes.cnpjCpf === cnpjEmitente) {
      erros.push({
        campo: "chaveAcesso",
        mensagem: "Esta chave é de uma nota emitida pela sua própria empresa. Na devolução de compra, a chave é a da nota do fornecedor.",
      });
    }
    if (entrada.destinatario) {
      erros.push(...conferirDestinatarioDaChave("COMPRA_SAIDA", partes.chave, entrada.destinatario));
    }
    const ufFornecedor = partes.uf;
    if (!ufFornecedor) erros.push({ campo: "chaveAcesso", mensagem: "O código de estado desta chave não existe." });
    const idDest: IdDest | null = ufFornecedor && ufEmitente ? (ufFornecedor === ufEmitente ? 1 : 2) : null;
    return { erros, idDest, ufDestinatario: ufFornecedor };
  }

  if (partes.cnpjCpf !== cnpjEmitente) {
    erros.push({
      campo: "chaveAcesso",
      mensagem: `Esta chave não é de uma nota emitida pela sua empresa (pela chave, quem emitiu foi ${formatarCnpjCpf(partes.cnpjCpf)}). Na devolução de venda, a chave é a da sua nota de venda.`,
    });
  }
  if (entrada.destinatario?.tipoPessoa === "EXTERIOR") {
    return { erros, idDest: 3, ufDestinatario: ufDigitada };
  }
  const digitos = new Set(
    (entrada.itens ?? [])
      .map((i) => (i.cfopOriginal ?? "").replace(/\D/g, ""))
      .filter((c) => c.length === 4 && IDDEST_POR_DIGITO_CFOP[c[0]] !== undefined)
      .map((c) => c[0]),
  );
  const idDestCfop: IdDest | null = digitos.size === 1 ? IDDEST_POR_DIGITO_CFOP[Array.from(digitos)[0]] : null;
  const ufValida = ufDigitada !== null && UFS_VALIDAS.has(ufDigitada);
  if (ufDigitada !== null && !ufValida) {
    erros.push({ campo: "destinatario.uf", mensagem: "UF inválida: use a sigla do estado (SC, PR, SP...)." });
  }
  const idDestUf: IdDest | null = ufValida && ufEmitente ? (ufDigitada === ufEmitente ? 1 : 2) : null;
  if (idDestUf !== null && idDestCfop !== null && idDestUf !== idDestCfop) {
    const doCfop =
      idDestCfop === 1 ? "de venda dentro do estado" : idDestCfop === 2 ? "de venda para fora do estado" : "de venda para o exterior";
    erros.push({
      campo: "destinatario.uf",
      mensagem: `A UF do cliente (${ufDigitada}) não combina com o CFOP da venda original, que é ${doCfop}.`,
    });
  }
  const idDest = idDestUf ?? idDestCfop;
  if (idDest === null && ufDigitada === null) {
    erros.push({
      campo: "destinatario.uf",
      mensagem: "Informe a UF do cliente: sem ela o Dexo não sabe se a devolução é de dentro ou de fora do estado.",
    });
  }
  return { erros, idDest, ufDestinatario: ufValida ? ufDigitada : null };
}

/** Leitura defensiva da resposta 200/201 do POST de criação (cliente). */
export function parseCriarDevolucaoResposta(raw: unknown): ResultadoParse<CriarDevolucaoResposta> {
  if (!isObj(raw) || typeof raw.draftId !== "string" || raw.draftId === "") {
    return { ok: false, erros: [{ campo: "draftId", mensagem: "Resposta sem draftId." }] };
  }
  return { ok: true, value: { draftId: raw.draftId, reutilizado: raw.reutilizado === true } };
}
