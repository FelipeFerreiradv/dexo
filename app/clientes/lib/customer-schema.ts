import { z } from "zod";
import { isValidCpf, isValidCnpj, onlyDigits } from "@/app/lib/masks";

const optionalStr = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v === "" ? null : (v ?? null)));

export const customerSchema = z.object({
  // Step 1 — Identificação
  name: z.string().min(2, "Nome é obrigatório").max(120),
  cpf: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || onlyDigits(v).length === 0 || isValidCpf(v),
      "CPF inválido",
    ),
  rg: optionalStr,
  birthDate: optionalStr,
  gender: optionalStr,
  maritalStatus: optionalStr,

  // Step 2 — Contato
  email: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      "E-mail inválido",
    ),
  phone: optionalStr,
  mobile: optionalStr,

  // Step 3 — Endereço
  cep: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || onlyDigits(v).length === 0 || onlyDigits(v).length === 8,
      "CEP deve ter 8 dígitos",
    ),
  street: optionalStr,
  number: optionalStr,
  complement: optionalStr,
  neighborhood: optionalStr,
  city: optionalStr,
  state: z
    .string()
    .optional()
    .nullable()
    .refine((v) => !v || v.length === 0 || /^[A-Za-z]{2}$/.test(v), "UF inválida"),
  ibge: optionalStr,
  reference: optionalStr,

  // Step 4 — Dados de entrega / PJ
  deliveryName: optionalStr,
  deliveryCorporateName: optionalStr,
  deliveryCpf: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || onlyDigits(v).length === 0 || isValidCpf(v),
      "CPF de entrega inválido",
    ),
  deliveryCnpj: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || onlyDigits(v).length === 0 || isValidCnpj(v),
      "CNPJ inválido",
    ),
  deliveryRg: optionalStr,
  deliveryCep: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || onlyDigits(v).length === 0 || onlyDigits(v).length === 8,
      "CEP de entrega inválido",
    ),
  deliveryPhone: optionalStr,
  deliveryCity: optionalStr,
  deliveryNeighborhood: optionalStr,
  deliveryState: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => !v || v.length === 0 || /^[A-Za-z]{2}$/.test(v),
      "UF de entrega inválida",
    ),
  deliveryStreet: optionalStr,
  deliveryComplement: optionalStr,
  deliveryNumber: optionalStr,

  notes: optionalStr,
});

export type CustomerFormData = z.infer<typeof customerSchema>;

export const DEFAULT_CUSTOMER_VALUES: CustomerFormData = {
  name: "",
  cpf: "",
  rg: "",
  birthDate: "",
  gender: "",
  maritalStatus: "",
  email: "",
  phone: "",
  mobile: "",
  cep: "",
  street: "",
  number: "",
  complement: "",
  neighborhood: "",
  city: "",
  state: "",
  ibge: "",
  reference: "",
  deliveryName: "",
  deliveryCorporateName: "",
  deliveryCpf: "",
  deliveryCnpj: "",
  deliveryRg: "",
  deliveryCep: "",
  deliveryPhone: "",
  deliveryCity: "",
  deliveryNeighborhood: "",
  deliveryState: "",
  deliveryStreet: "",
  deliveryComplement: "",
  deliveryNumber: "",
  notes: "",
};
