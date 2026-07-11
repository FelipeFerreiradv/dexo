/**
 * Clientes do Vaapt (planilha "# Cod Cliente, Nome Cliente, CPF, CNPJ,
 * Endereco, Numero, Complemento, Bairro, Cidade, UF, CEP, Telefone, Email,
 * RG, IE, TipoPessoa"). Mapeamento fiel ao phase2Customers de
 * scripts/migracao-vaapt.ts: padDoc recupera zeros do Excel e rejeita
 * placeholders; nomes-lixo são descartados; dedup intra-planilha por
 * cod/cpf/cnpj. O usecase de Customer NÃO valida UF/CEP/placeholder — essas
 * validações acontecem AQUI, na fase de mapeamento.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import {
  asString,
  cleanUndefined,
  isPlaceholderName,
  onlyDigits,
  toCep,
  toEmail,
  toUf,
  validCNPJ,
  validCPF,
} from "../lib/normalize";
import { importCustomerMarker } from "../lib/markers";

export interface CustomerPlanItem {
  linha: number;
  /** Código legado (chave de idempotência no marker em notes). */
  cod: string | null;
  personType: "PF" | "PJ";
  name: string;
  cpf: string | null;
  cnpj: string | null;
  rg?: string | null;
  inscricaoEstadual?: string | null;
  indicadorIE?: string | null;
  nomeFantasia?: string | null;
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
  notes: string;
}

export interface CustomersMapResult {
  items: CustomerPlanItem[];
  totalRows: number;
  skippedPlaceholder: number;
  skippedDuplicateInSheet: number;
  /** Avisos de mapeamento (ex.: UF inválida descartada). */
  avisos: ImportRowIssue[];
}

export function mapVaaptCustomers(file: DetectedFile): CustomersMapResult {
  const items: CustomerPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenCod = new Set<string>();
  const seenCpf = new Set<string>();
  const seenCnpj = new Set<string>();
  let skippedPlaceholder = 0;
  let skippedDuplicateInSheet = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const cod = asString(get("# Cod Cliente"));
    const rawName = asString(get("Nome Cliente"));
    const personType =
      (asString(get("TipoPessoa")) ?? "PF").toUpperCase() === "PJ"
        ? "PJ"
        : "PF";
    const cpf = validCPF(get("CPF"));
    const cnpj = validCNPJ(get("CNPJ"));

    if (!rawName || isPlaceholderName(rawName)) {
      skippedPlaceholder++;
      continue;
    }
    if (
      (cod && seenCod.has(cod)) ||
      (cpf && seenCpf.has(cpf)) ||
      (cnpj && seenCnpj.has(cnpj))
    ) {
      skippedDuplicateInSheet++;
      continue;
    }
    if (cod) seenCod.add(cod);
    if (cpf) seenCpf.add(cpf);
    if (cnpj) seenCnpj.add(cnpj);

    const uf = toUf(get("UF"));
    if (!uf && asString(get("UF"))) {
      addIssue(avisos, {
        linha,
        motivo: `UF inválida "${asString(get("UF"))}" — endereço gravado sem estado`,
      });
    }

    const ie = asString(get("IE"));
    items.push({
      linha,
      cod,
      personType,
      name: rawName,
      cpf,
      cnpj,
      rg: asString(get("RG")),
      inscricaoEstadual: ie,
      indicadorIE: personType === "PJ" && ie ? "1" : "9",
      email: toEmail(get("Email")),
      phone: onlyDigits(get("Telefone")) || null,
      cep: toCep(get("CEP")),
      street: asString(get("Endereco")),
      number: cleanUndefined(get("Numero")),
      complement: cleanUndefined(get("Complemento")),
      neighborhood: asString(get("Bairro")),
      city: asString(get("Cidade")),
      state: uf,
      notes: cod ? importCustomerMarker(cod) : "Import Dexo",
    });
  }

  return {
    items,
    totalRows: file.rows.length,
    skippedPlaceholder,
    skippedDuplicateInSheet,
    avisos,
  };
}
