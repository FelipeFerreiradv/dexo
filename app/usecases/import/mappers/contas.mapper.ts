/**
 * Contas a pagar/receber — GREENFIELD: nenhum export legado traz contas,
 * então o formato é um template CSV próprio do Dexo (documentado em
 * docs/importacao-superadmin.md):
 *
 *   tipo,documento,cliente_cpf_cnpj,cliente_nome,valor,vencimento,status,
 *   pago_em,forma_pagamento,parcelas,observacao
 *
 * Regras (as mesmas que o FinanceUseCase impõe, antecipadas aqui para a
 * prévia reportar por linha): valor > 0; vencimento obrigatório; FIADO só
 * em contas a receber; conta histórica paga entra com status PAGA + pago_em
 * DIRETO NO CREATE (nunca markPaid — que dispara baixa de estoque/sync).
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import {
  asInt,
  asNumber,
  asString,
  onlyDigits,
  parseFlexibleDate,
  validCNPJ,
  validCPF,
} from "../lib/normalize";
import { importFinanceMarker } from "../lib/markers";
import { shortLineHash } from "../lib/preview-hash";

export type FinanceKind = "receivable" | "payable";
export type FinanceStatusPlan = "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";

const PAYMENT_METHODS = new Set([
  "PIX",
  "CREDITO",
  "DEBITO",
  "BOLETO",
  "DINHEIRO",
  "TRANSFERENCIA",
  "FIADO",
]);

export interface FinancePlanItem {
  linha: number;
  kind: FinanceKind;
  document?: string | null;
  /** Documento do cliente para o casamento (prioridade sobre o nome). */
  customerCpf?: string | null;
  customerCnpj?: string | null;
  customerName?: string | null;
  totalAmount: number;
  dueDate: Date;
  status: FinanceStatusPlan;
  paidAt?: Date | null;
  paymentMethod?: string | null;
  installments: number;
  /** Observação + marker de idempotência "[import <hash8>]". */
  reason: string;
  markerHash: string;
}

export interface FinanceMapResult {
  items: FinancePlanItem[];
  totalRows: number;
  erros: ImportRowIssue[];
  avisos: ImportRowIssue[];
}

function mapKind(raw: string | null): FinanceKind | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (["receber", "receivable", "cr", "a receber"].includes(s)) {
    return "receivable";
  }
  if (["pagar", "payable", "cp", "a pagar"].includes(s)) return "payable";
  return null;
}

function mapStatus(raw: string | null): FinanceStatusPlan | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "" || s.startsWith("pendente") || s.startsWith("abert")) {
    return "PENDENTE";
  }
  if (s.startsWith("pag")) return "PAGA";
  if (s.startsWith("venc")) return "VENCIDA";
  if (s.startsWith("cancel")) return "CANCELADA";
  return null;
}

export function mapContas(file: DetectedFile): FinanceMapResult {
  const items: FinancePlanItem[] = [];
  const erros: ImportRowIssue[] = [];
  const avisos: ImportRowIssue[] = [];
  // Ocorrências por hash-base: duas linhas LEGÍTIMAS idênticas (ex.: duas
  // contas iguais do mesmo fornecedor no mesmo dia) recebem markers
  // distintos (#0, #1…) — determinístico na ordem do arquivo, então a
  // reimportação continua casando 1:1 com o que foi criado.
  const hashOccurrences = new Map<string, number>();

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const kind = mapKind(asString(get("tipo")));
    if (!kind) {
      addIssue(erros, {
        linha,
        motivo: `tipo "${asString(get("tipo")) ?? ""}" inválido — use "receber" ou "pagar"`,
      });
      continue;
    }

    const totalAmount = asNumber(get("valor"));
    if (totalAmount === null || totalAmount <= 0) {
      addIssue(erros, { linha, motivo: "valor deve ser um número maior que zero" });
      continue;
    }

    const dueDate = parseFlexibleDate(get("vencimento"));
    if (!dueDate) {
      addIssue(erros, { linha, motivo: "vencimento obrigatório (dd/mm/aaaa ou aaaa-mm-dd)" });
      continue;
    }

    const status = mapStatus(asString(get("status")));
    if (!status) {
      addIssue(erros, {
        linha,
        motivo: `status "${asString(get("status"))}" inválido — use pendente, paga, vencida ou cancelada`,
      });
      continue;
    }

    let paymentMethod: string | null = null;
    const pmRaw = asString(get("forma_pagamento"));
    if (pmRaw) {
      const pm = pmRaw
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toUpperCase()
        .trim();
      if (!PAYMENT_METHODS.has(pm)) {
        addIssue(erros, {
          linha,
          motivo: `forma_pagamento "${pmRaw}" inválida — use PIX, CREDITO, DEBITO, BOLETO, DINHEIRO, TRANSFERENCIA ou FIADO`,
        });
        continue;
      }
      if (pm === "FIADO" && kind !== "receivable") {
        addIssue(erros, {
          linha,
          motivo: "FIADO só é permitido em contas a RECEBER",
        });
        continue;
      }
      paymentMethod = pm;
    }

    let paidAt = parseFlexibleDate(get("pago_em"));
    if (status === "PAGA" && !paidAt) {
      paidAt = dueDate;
      addIssue(avisos, {
        linha,
        motivo: "conta PAGA sem pago_em — usando a data de vencimento",
      });
    }
    if (status !== "PAGA") paidAt = null;

    // Cliente: documento tem prioridade; nome exato é o fallback.
    const docDigits = onlyDigits(get("cliente_cpf_cnpj"));
    const customerCpf = docDigits.length > 0 && docDigits.length <= 11 ? validCPF(docDigits) : null;
    const customerCnpj = docDigits.length > 11 ? validCNPJ(docDigits) : null;
    const customerName = asString(get("cliente_nome"));
    if (docDigits.length > 0 && !customerCpf && !customerCnpj) {
      addIssue(avisos, {
        linha,
        motivo: `cliente_cpf_cnpj "${docDigits}" com comprimento inválido — tentando casar pelo nome`,
      });
    }
    if (!customerCpf && !customerCnpj && !customerName) {
      addIssue(erros, {
        linha,
        motivo: "informe cliente_cpf_cnpj ou cliente_nome (a conta exige um cliente)",
      });
      continue;
    }

    const document = asString(get("documento"));
    const observacao = asString(get("observacao"));
    const installments = Math.max(1, asInt(get("parcelas")) ?? 1);
    // O hash cobre TODOS os campos que distinguem uma conta (status,
    // parcelas, forma e observação inclusos) — duas linhas diferentes nunca
    // colapsam no mesmo marker; idênticas são separadas pela ocorrência.
    const baseHash = shortLineHash([
      kind,
      document,
      docDigits || customerName,
      totalAmount,
      dueDate.toISOString().slice(0, 10),
      status,
      paidAt ? paidAt.toISOString().slice(0, 10) : "",
      paymentMethod,
      installments,
      observacao,
    ]);
    const occurrence = hashOccurrences.get(baseHash) ?? 0;
    hashOccurrences.set(baseHash, occurrence + 1);
    const markerHash = shortLineHash([baseHash, occurrence]);
    const reasonParts = [observacao, importFinanceMarker(markerHash)].filter(
      (p): p is string => !!p,
    );

    items.push({
      linha,
      kind,
      document,
      customerCpf,
      customerCnpj,
      customerName,
      totalAmount,
      dueDate,
      status,
      paidAt,
      paymentMethod,
      installments,
      reason: reasonParts.join(" "),
      markerHash,
    });
  }

  return { items, totalRows: file.rows.length, erros, avisos };
}
