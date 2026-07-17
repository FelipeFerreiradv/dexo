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

  // ── NFC-e (modelo 65) — Fase 2. Campos OPCIONAIS na interface para não
  // quebrar construções literais existentes (projeção from-xml, fixtures). ──
  /** Série própria da NFC-e (numeração independente por modelo). */
  serieNfce?: number;
  /** idCSC (cIdToken) cadastrado na SEFAZ. */
  cscId?: string | null;
  /** CSC — segredo do hash do QR Code (nunca volta ao cliente). */
  cscToken?: string | null;
  /** NCM padrão (8 dígitos) p/ autopreencher itens sem NCM. */
  ncmPadrao?: string | null;

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

  // ── NFC-e (Fase 2) — todos opcionais; ausentes = comportamento atual. ──
  /** Série da NFC-e (inteiro 1–999). Default 1. */
  serieNfce?: number | null;
  cscId?: string | null;
  /** Vazio/ausente preserva o CSC salvo (padrão providerToken). */
  cscToken?: string | null;
  /** NCM padrão (8 dígitos) ou vazio p/ limpar. */
  ncmPadrao?: string | null;
}
