export interface AddressFromCep {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  ibge: string;
}

export async function fetchAddressByCep(
  cep: string,
): Promise<AddressFromCep | null> {
  const clean = cep.replace(/\D/g, "");
  if (clean.length !== 8) return null;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.erro) return null;
    return {
      street: data.logradouro ?? "",
      neighborhood: data.bairro ?? "",
      city: data.localidade ?? "",
      state: data.uf ?? "",
      ibge: data.ibge ?? "",
    };
  } catch {
    return null;
  }
}
