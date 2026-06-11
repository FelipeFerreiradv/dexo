export type FiscalAmbiente = "HOMOLOGACAO" | "PRODUCAO";
export type RegimeTributario = "SIMPLES" | "LUCRO_PRESUMIDO" | "LUCRO_REAL";

export interface CompanyFiscalConfig {
  id: string;
  userId: string;

  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  inscricaoEstadual: string;
  inscricaoMunicipal: string | null;
  regimeTributario: RegimeTributario;
  cnae: string | null;

  ambiente: FiscalAmbiente;

  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio: string | null;
  codMunicipio: string | null;
  uf: string | null;
  codPais: string | null;
  pais: string | null;

  certificadoPath: string | null;
  certificadoSenhaEnc: string | null;
  certificadoValidoAte: Date | null;
  certificadoSubjectCN: string | null;

  providerName: string | null;
  providerToken: string | null;

  /** Série padrão das NF-e (o número é sequencial automático por série). */
  serieNfe: number;

  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyFiscalConfigUpsert {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  inscricaoEstadual: string;
  inscricaoMunicipal?: string | null;
  regimeTributario: RegimeTributario;
  cnae?: string | null;

  ambiente?: FiscalAmbiente;

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

  providerName?: string | null;
  providerToken?: string | null;

  /** Série padrão das NF-e (inteiro 1–999). Default 1. */
  serieNfe?: number | null;
}
