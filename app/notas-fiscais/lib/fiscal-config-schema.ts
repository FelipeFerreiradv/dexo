import { z } from "zod";
import { isValidCnpj, onlyDigits } from "@/app/lib/masks";

const optionalStr = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v === "" ? null : (v ?? null)));

export const fiscalConfigSchema = z.object({
  // Step 1 — Identificação
  cnpj: z
    .string()
    .min(1, "CNPJ é obrigatório")
    .refine((v) => isValidCnpj(v), "CNPJ inválido"),
  razaoSocial: z.string().min(2, "Razão social é obrigatória").max(200),
  nomeFantasia: optionalStr,
  inscricaoEstadual: z.string().min(1, "Inscrição estadual é obrigatória"),
  inscricaoMunicipal: optionalStr,
  regimeTributario: z.enum(["SIMPLES", "LUCRO_PRESUMIDO", "LUCRO_REAL"], {
    message: "Regime tributário é obrigatório",
  }),
  cnae: optionalStr,

  // Step 2 — Endereço fiscal
  cep: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || onlyDigits(v).length === 0 || onlyDigits(v).length === 8,
      "CEP deve ter 8 dígitos",
    ),
  logradouro: optionalStr,
  numero: optionalStr,
  complemento: optionalStr,
  bairro: optionalStr,
  municipio: optionalStr,
  codMunicipio: optionalStr,
  uf: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || v.length === 0 || /^[A-Za-z]{2}$/.test(v),
      "UF inválida",
    ),

  // Step 3 — Ambiente & Provedor
  ambiente: z.enum(["HOMOLOGACAO", "PRODUCAO"]),
  providerName: optionalStr,
  providerToken: optionalStr,
  serieNfe: z.coerce
    .number()
    .int("Série deve ser um número inteiro")
    .min(1, "Série deve ser entre 1 e 999")
    .max(999, "Série deve ser entre 1 e 999"),

  // ── NFC-e (Fase 2) — todos opcionais; vazios = comportamento atual. ──
  serieNfce: z.coerce
    .number()
    .int("Série da NFC-e deve ser um número inteiro")
    .min(1, "Série da NFC-e deve ser entre 1 e 999")
    .max(999, "Série da NFC-e deve ser entre 1 e 999"),
  cscId: optionalStr,
  // Segredo: vazio preserva o CSC salvo (padrão providerToken).
  cscToken: optionalStr,
  ncmPadrao: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || onlyDigits(v).length === 0 || onlyDigits(v).length === 8,
      "NCM padrão deve ter 8 dígitos",
    ),
});

export type FiscalConfigFormData = z.infer<typeof fiscalConfigSchema>;

export const DEFAULT_FISCAL_CONFIG: FiscalConfigFormData = {
  cnpj: "",
  razaoSocial: "",
  nomeFantasia: "",
  inscricaoEstadual: "",
  inscricaoMunicipal: "",
  regimeTributario: "SIMPLES",
  cnae: "",
  cep: "",
  logradouro: "",
  numero: "",
  complemento: "",
  bairro: "",
  municipio: "",
  codMunicipio: "",
  uf: "",
  ambiente: "HOMOLOGACAO",
  providerName: "FOCUS_NFE",
  providerToken: "",
  serieNfe: 1,
  serieNfce: 1,
  cscId: "",
  cscToken: "",
  ncmPadrao: "",
};
