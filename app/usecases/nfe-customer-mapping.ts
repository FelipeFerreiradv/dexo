import type { CustomerCreate } from "../interfaces/customer.interface";

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
