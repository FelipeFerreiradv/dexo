import type { CustomerCreate } from "../interfaces/customer.interface";
import type { NfeDestinatario } from "../interfaces/nfe.interface";

/** Snapshot mínimo do destinatário da NF-e (subconjunto de NfeDestinatario). */
export interface DestinatarioSnapshot {
  tipoPessoa?: string | null;
  cpfCnpj?: string | null;
  nome?: string | null;
  inscricaoEstadual?: string | null;
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
}

/**
 * Mapeia o snapshot de destinatário da NF-e (destinatarioJson) para a forma de
 * criação de Customer. Puro (sem I/O) e sem dependências pesadas, para teste
 * isolado. PF usa CPF; PJ usa CNPJ + razão social (a coluna `name` recebe a
 * razão social via CustomerUseCase). O tipo é inferido por tipoPessoa, com
 * fallback pelo comprimento do documento (14 dígitos = CNPJ).
 */
export function mapDestinatarioToCustomer(
  dest: DestinatarioSnapshot,
  userId: string,
): CustomerCreate {
  const doc = (dest?.cpfCnpj ?? "").toString().replace(/\D/g, "");
  const isPj = dest?.tipoPessoa === "PJ" || doc.length === 14;
  return {
    userId,
    personType: isPj ? "PJ" : "PF",
    name: dest?.nome ?? "",
    cpf: isPj ? null : doc || null,
    cnpj: isPj ? doc || null : null,
    razaoSocial: isPj ? (dest?.nome ?? null) : null,
    inscricaoEstadual: dest?.inscricaoEstadual ?? null,
    email: dest?.email ?? null,
    phone: dest?.telefone ?? null,
    cep: dest?.cep ?? null,
    street: dest?.logradouro ?? null,
    number: dest?.numero ?? null,
    complement: dest?.complemento ?? null,
    neighborhood: dest?.bairro ?? null,
    city: dest?.municipio ?? null,
    state: dest?.uf ?? null,
    ibge: dest?.codMunicipio ?? null,
  };
}

/**
 * Cliente (Customer/CustomerLookup) → forma de criação do destinatário da NF-e.
 * Estrutural: aceita tanto o `Customer` completo (Prisma) quanto o
 * `CustomerLookup` do wizard — todos os campos são opcionais/nuláveis.
 * Puro (sem I/O), reutilizado no pedido, no balcão e na busca manual.
 */
export interface CustomerForDestinatario {
  personType?: string | null;
  name?: string | null;
  cpf?: string | null;
  cnpj?: string | null;
  razaoSocial?: string | null;
  deliveryCnpj?: string | null;
  deliveryCorporateName?: string | null;
  inscricaoEstadual?: string | null;
  indicadorIE?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  cep?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  ibge?: string | null;
  // País (quando conhecido). Ausente/1058 = Brasil. Presente e ≠ 1058 = exterior.
  codPais?: string | null;
  pais?: string | null;
}

const IND_IE_VALORES = new Set(["1", "2", "9"]);

/**
 * indicadorIE do destinatário (1=Contribuinte, 2=Isento, 9=Não contribuinte).
 * Prioriza o valor já cadastrado no Customer; senão deriva pela regra do
 * projeto: PJ com IE preenchida (≠ ISENTO) → "1"; IE = "ISENTO" → "2"; PF ou
 * sem IE → "9". Só popula o formulário/rascunho — os geradores de XML seguem
 * derivando o indIEDest como hoje (sem regressão fiscal).
 */
export function resolveIndicadorIE(
  stored: string | null | undefined,
  isPj: boolean,
  ie: string | null | undefined,
): string {
  if (stored && IND_IE_VALORES.has(stored)) return stored;
  const t = (ie ?? "").trim().toUpperCase();
  if (isPj && t && t !== "ISENTO") return "1";
  if (t === "ISENTO") return "2";
  return "9";
}

/**
 * Infere o tipo de pessoa do destinatário. EXTERIOR quando há país estrangeiro
 * (codPais presente e ≠ "1058"); senão PJ quando há sinal de PJ (personType,
 * cnpj/deliveryCnpj ou documento com 14 dígitos); senão PF.
 */
export function inferTipoPessoaFromCustomer(
  c: CustomerForDestinatario,
): "PF" | "PJ" | "EXTERIOR" {
  const codPais = (c.codPais ?? "").trim();
  if (codPais && codPais !== "1058") return "EXTERIOR";
  const doc14 =
    (c.cnpj ?? c.deliveryCnpj ?? c.cpf ?? "").replace(/\D/g, "").length === 14;
  if (c.personType === "PJ" || !!c.cnpj || !!c.deliveryCnpj || doc14) {
    return "PJ";
  }
  return "PF";
}

/**
 * Snapshot achatado dos dados fiscais do comprador de um pedido de marketplace
 * (ex.: ML billing_info). Puro/estrutural — o caller (usecase) achata a
 * resposta da API para cá, mantendo este módulo sem dependência do serviço ML.
 */
export interface MarketplaceBillingSnapshot {
  name?: string | null;
  lastName?: string | null;
  docType?: string | null; // "CPF" | "CNPJ" | ...
  docNumber?: string | null;
  cep?: string | null;
  street?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  uf?: string | null;
  countryId?: string | null; // "BR" | ...
  countryName?: string | null;
}

/**
 * Dados fiscais do comprador (marketplace) → destinatário da NF-e. Retorna null
 * quando não há documento (sem CPF/CNPJ não vale sobrescrever o fallback).
 * `fallbackNome`/`fallbackEmail` = nome/e-mail do pedido, usados quando o
 * billing não os traz.
 */
/** ML devolve a UF em ISO 3166-2 ("BR-PA"); a NF-e usa a sigla ("PA"). */
function normalizeUf(raw?: string | null): string | null {
  if (!raw) return null;
  const parts = raw.trim().toUpperCase().split("-");
  const uf = parts[parts.length - 1];
  return uf.length === 2 ? uf : raw.trim() || null;
}

export function mapMarketplaceBillingToDestinatario(
  b: MarketplaceBillingSnapshot,
  fallbackNome?: string | null,
  fallbackEmail?: string | null,
): NfeDestinatario | null {
  const doc = (b.docNumber ?? "").replace(/\D/g, "");
  if (!doc) return null;
  const isPj = (b.docType ?? "").toUpperCase() === "CNPJ" || doc.length === 14;
  const nome =
    [b.name, b.lastName].filter(Boolean).join(" ").trim() ||
    (fallbackNome ?? "");
  const country = (b.countryId ?? "BR").toUpperCase();
  const isExterior = country !== "BR" && country !== "BRA" && country !== "1058";
  return {
    tipoPessoa: isExterior ? "EXTERIOR" : isPj ? "PJ" : "PF",
    cpfCnpj: doc,
    nome,
    inscricaoEstadual: null,
    indicadorIE: resolveIndicadorIE(null, isPj, null),
    email: fallbackEmail ?? null,
    telefone: null,
    cep: b.cep ?? null,
    logradouro: b.street ?? null,
    numero: b.number ?? null,
    complemento: null,
    bairro: b.neighborhood ?? null,
    municipio: b.city ?? null,
    // ML não fornece código IBGE — fica nulo; o wizard/CEP completa.
    codMunicipio: null,
    uf: normalizeUf(b.uf),
    codPais: isExterior ? null : "1058",
    pais: isExterior ? (b.countryName ?? null) : "BRASIL",
  };
}

export function mapCustomerToDestinatario(
  c: CustomerForDestinatario,
): NfeDestinatario {
  const tipoPessoa = inferTipoPessoaFromCustomer(c);
  const isPj = tipoPessoa === "PJ";
  const doc = isPj ? (c.cnpj ?? c.deliveryCnpj ?? "") : (c.cpf ?? "");
  const nome = isPj
    ? (c.razaoSocial ?? c.deliveryCorporateName ?? c.name ?? "")
    : (c.name ?? "");
  const ie = c.inscricaoEstadual ?? null;
  const codPais = (c.codPais ?? "").trim();
  const isExterior = tipoPessoa === "EXTERIOR";
  return {
    tipoPessoa,
    cpfCnpj: doc ?? "",
    nome,
    inscricaoEstadual: ie,
    indicadorIE: resolveIndicadorIE(c.indicadorIE, isPj, ie),
    email: c.email ?? null,
    telefone: c.phone ?? c.mobile ?? null,
    cep: c.cep ?? null,
    logradouro: c.street ?? null,
    numero: c.number ?? null,
    complemento: c.complement ?? null,
    bairro: c.neighborhood ?? null,
    municipio: c.city ?? null,
    codMunicipio: c.ibge ?? null,
    uf: c.state ?? null,
    codPais: isExterior && codPais ? codPais : "1058",
    pais: isExterior ? (c.pais ?? null) : "BRASIL",
  };
}
