export interface CompanyFromCnpj {
  razaoSocial: string;
  nomeFantasia: string;
  cep: string;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
}

/**
 * Consulta dados públicos de um CNPJ na BrasilAPI (gratuita, sem chave, com
 * CORS — mesmo padrão de `cep-service`). Retorna null em qualquer falha para a
 * UI degradar silenciosamente (o usuário sempre pode preencher à mão).
 */
export async function fetchCompanyByCnpj(
  cnpj: string,
): Promise<CompanyFromCnpj | null> {
  const clean = cnpj.replace(/\D/g, "");
  if (clean.length !== 14) return null;
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${clean}`);
    if (!res.ok) return null;
    const d = await res.json();
    return {
      razaoSocial: d.razao_social ?? "",
      nomeFantasia: d.nome_fantasia ?? "",
      cep: d.cep ? String(d.cep).replace(/\D/g, "") : "",
      street: d.logradouro ?? "",
      number: d.numero ? String(d.numero) : "",
      neighborhood: d.bairro ?? "",
      city: d.municipio ?? "",
      state: d.uf ?? "",
    };
  } catch {
    return null;
  }
}
