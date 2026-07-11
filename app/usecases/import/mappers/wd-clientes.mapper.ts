/**
 * Clientes do WebDesmonte (customers.csv — presente em alguns pacotes, ex.:
 * Ribeiro; o pacote K2 não traz). Colunas relevantes: Id (GUID), Name,
 * FantasyName, Type, Document, RgIe, Phone, CellPhone, Email (+ endereço,
 * quando o export traz). PF/PJ decidido pelo comprimento do Document
 * (11 → PF, 14 → PJ), com o Type como desempate.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import {
  asString,
  isPlaceholderName,
  normName,
  onlyDigits,
  toCep,
  toEmail,
  toUf,
  validCNPJ,
  validCPF,
} from "../lib/normalize";
import { importCustomerMarker } from "../lib/markers";
import {
  pseudoCustomerCod,
  type CustomerPlanItem,
  type CustomersMapResult,
} from "./vaapt-clientes.mapper";

export function mapWdCustomers(file: DetectedFile): CustomersMapResult {
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

    const rawName = asString(get("Name"));
    if (!rawName || isPlaceholderName(rawName)) {
      skippedPlaceholder++;
      continue;
    }
    const cod =
      asString(get("Id")) ??
      pseudoCustomerCod([
        normName(rawName),
        asString(get("Email")),
        onlyDigits(get("Phone")),
        onlyDigits(get("CellPhone")),
      ]);

    // PF/PJ pelo comprimento do documento; Type ("F"/"J") como desempate.
    const docDigits = onlyDigits(get("Document"));
    const typeRaw = (asString(get("Type")) ?? "").toUpperCase();
    const isPj =
      docDigits.length > 11 || typeRaw.startsWith("J") || typeRaw === "PJ";
    const cpf = !isPj ? validCPF(get("Document")) : null;
    const cnpj = isPj ? validCNPJ(get("Document")) : null;

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

    const rgIe = asString(get("RgIe"));
    // Endereço: nomes de coluna variam entre exports — leitura best-effort
    // (coluna ausente = campo nulo; o getter devolve null).
    const street = asString(get("Address")) ?? asString(get("Street"));
    const uf = toUf(get("State")) ?? toUf(get("Uf"));

    items.push({
      linha,
      cod,
      personType: isPj ? "PJ" : "PF",
      name: rawName,
      cpf,
      cnpj,
      rg: !isPj ? rgIe : null,
      inscricaoEstadual: isPj ? rgIe : null,
      indicadorIE: isPj && rgIe ? "1" : "9",
      nomeFantasia: asString(get("FantasyName")),
      email: toEmail(get("Email")),
      phone: onlyDigits(get("Phone")) || null,
      mobile: onlyDigits(get("CellPhone")) || null,
      cep: toCep(get("ZipCode")) ?? toCep(get("Cep")),
      street,
      number: asString(get("Number")),
      complement: asString(get("Complement")),
      neighborhood: asString(get("District")) ?? asString(get("Neighborhood")),
      city: asString(get("City")),
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
