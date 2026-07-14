/**
 * Mapeadores do export COMPLETO do IBR Soft (CSV ";", colunas em português
 * snake_case). Cada mapper produz o mesmo PlanItem que os executores já
 * consomem, para reuso total da lógica de escrita validada:
 *   costumers.csv       → CustomerPlanItem   (customers.executor)
 *   localizacoes.csv    → LocationPlanItem[] (locations.executor)
 *   sucatas.csv         → ScrapPlanItem      (scraps.executor)
 *   produtos.csv        → IbrsoftProdutoItem (executor próprio; cria+vincula)
 *   nfe.csv             → NfePlanItem        (nfe-import)
 *   contas_a_*.csv      → FinancePlanItem    (finance.executor)
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import { cumulativePaths, normPath } from "../lib/codes";
import {
  asInt,
  asNumber,
  asString,
  cleanChassis,
  cleanPlate,
  onlyDigits,
  parseFlexibleDate,
  toCep,
  toEmail,
  toUf,
  validCNPJ,
  validCPF,
} from "../lib/normalize";
import {
  importCustomerMarker,
  importFinanceMarker,
  importScrapWdMarker,
} from "../lib/markers";
import { shortLineHash } from "../lib/preview-hash";
import type {
  CustomerPlanItem,
  CustomersMapResult,
} from "./vaapt-clientes.mapper";
import type { LocationPlanItem } from "../executors/locations.executor";
import type { ScrapPlanItem, ScrapsMapResult } from "./sucatas.mapper";
import type { EstoquePlanItem } from "./ibr-estoque.mapper";
import type { NfePlanItem } from "./vaapt-nfes.mapper";
import type {
  FinancePlanItem,
  FinanceMapResult,
} from "./contas.mapper";

/** Flag booleana do IBR Soft ("t"/"true"/"1"/"sim" → true). */
function isTruthyFlag(v: unknown): boolean {
  const s = asString(v)?.toLowerCase();
  return s === "t" || s === "true" || s === "1" || s === "sim";
}

/* ------------------------------- Clientes ------------------------------ */

export function mapIbrsoftClientes(file: DetectedFile): CustomersMapResult {
  const items: CustomerPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenCod = new Set<string>();
  const seenCpf = new Set<string>();
  const seenCnpj = new Set<string>();
  let skippedPlaceholder = 0;
  let skippedDuplicateInSheet = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (l: string) => file.get(row, l);
    const linha = i + 1;

    const cod = asString(get("id"));
    const rawName = asString(get("nome_razao_social"));
    if (!rawName) {
      skippedPlaceholder++;
      continue;
    }
    const isPj = (asString(get("tipo")) ?? "").toLowerCase().includes("jurid");
    const cpf = !isPj ? validCPF(get("cpf_cnpj")) : null;
    const cnpj = isPj ? validCNPJ(get("cpf_cnpj")) : null;

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

    const rgIe = asString(get("rg_ie"));
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
      nomeFantasia: asString(get("nome_fantasia")),
      email: toEmail(get("email")),
      phone: onlyDigits(get("telefone")) || null,
      mobile: onlyDigits(get("celular")) || null,
      cep: toCep(get("cep")),
      street: asString(get("logradouro")),
      number: asString(get("numero")),
      complement: asString(get("complemento")),
      neighborhood: asString(get("bairro")),
      city: asString(get("cidade")),
      state: toUf(get("uf")),
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

/* ----------------------------- Localizações ---------------------------- */

export interface IbrsoftLocationsResult {
  items: LocationPlanItem[];
  totalRows: number;
}

/** Constrói a árvore de localizações a partir dos caminhos hierárquicos. */
export function buildIbrsoftLocationTree(
  paths: Array<{ caminho: string | null; maxCapacity?: number }>,
): LocationPlanItem[] {
  const byCode = new Map<string, LocationPlanItem>();
  for (const { caminho, maxCapacity } of paths) {
    const full = normPath(caminho);
    if (!full) continue;
    const segs = cumulativePaths(full);
    for (let d = 0; d < segs.length; d++) {
      const code = segs[d];
      const existing = byCode.get(code);
      if (!existing) {
        byCode.set(code, {
          code,
          description: code,
          // Capacidade só na FOLHA (o valor do arquivo é da localização final).
          maxCapacity: d === segs.length - 1 ? (maxCapacity ?? 0) : 0,
          parentCode: d > 0 ? segs[d - 1] : null,
        });
      } else if (d === segs.length - 1 && maxCapacity && !existing.maxCapacity) {
        existing.maxCapacity = maxCapacity;
      }
    }
  }
  return Array.from(byCode.values()).sort(
    (a, b) => cumulativePaths(a.code).length - cumulativePaths(b.code).length,
  );
}

export function mapIbrsoftLocalizacoes(
  file: DetectedFile,
): IbrsoftLocationsResult {
  const paths = file.rows.map((row) => ({
    caminho: asString(file.get(row, "caminho_siglas")),
    maxCapacity: asInt(file.get(row, "quantidade_maxima")) ?? 0,
  }));
  return { items: buildIbrsoftLocationTree(paths), totalRows: file.rows.length };
}

/* -------------------------------- Sucatas ------------------------------ */

export function mapIbrsoftSucatas(file: DetectedFile): ScrapsMapResult {
  const items: ScrapPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenCod = new Set<string>();
  let invalidRows = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (l: string) => file.get(row, l);
    const linha = i + 1;

    // Chave da sucata: codigo_sequencial (estável) com fallback no id (GUID).
    const cod = asString(get("codigo_sequencial")) ?? asString(get("id"));
    if (!cod) {
      invalidRows++;
      continue;
    }
    if (seenCod.has(cod)) {
      invalidRows++;
      continue;
    }
    seenCod.add(cod);

    // Chassi/chave só se válidos (o ScrapUseCase rejeita fora do padrão).
    const chassiRaw = asString(get("chassi"));
    const chassis = chassiRaw ? cleanChassis(chassiRaw) : null;
    if (chassiRaw && (!chassis || chassis.length !== 17)) {
      addIssue(avisos, {
        linha,
        motivo: `Sucata ${cod}: chassi "${chassiRaw}" inválido — gravada sem chassi`,
      });
    }
    const accessRaw = onlyDigits(get("chave_acesso_nfe"));
    const accessKey = accessRaw.length === 44 ? accessRaw : null;

    const lote = asString(get("lote"));
    const info = asString(get("informacoes_adicionais"));
    const notesParts = [importScrapWdMarker(cod)];
    if (lote) notesParts.push(`lote ${lote}`);
    if (info) notesParts.push(info);

    items.push({
      linha,
      cod,
      brand: asString(get("marca")) ?? "INDEFINIDO",
      model: asString(get("modelo")) ?? "INDEFINIDO",
      year: asString(get("ano")),
      version: asString(get("versao")),
      color: asString(get("cor")),
      plate: cleanPlate(get("placa")),
      chassis: chassis && chassis.length === 17 ? chassis : null,
      lot: lote,
      deregistrationCert: asString(get("certidao_baixa")),
      cost: asNumber(get("valor_compra")),
      ncm: asString(get("ncm")),
      accessKey,
      nfeNumber: asString(get("numero_nfe")),
      nfeSeries: asString(get("serie_nfe")),
      renavam: asString(get("renavam")),
      engineNumber: asString(get("numero_motor")),
      entryDate: parseFlexibleDate(get("data_entrada")),
      locationCode: normPath(get("sigla_localizacao")),
      notes: notesParts.join(" · "),
    });
  }
  return { items, totalRows: file.rows.length, invalidRows, avisos };
}

/* ------------------------------- Produtos ------------------------------ */

export interface IbrsoftProdutoItem extends EstoquePlanItem {
  /** Placa da sucata de origem (vínculo produto→sucata). */
  scrapPlate: string | null;
  /** Lote da sucata de origem (fallback do vínculo). */
  scrapLote: string | null;
}

export interface IbrsoftProdutosResult {
  produtos: IbrsoftProdutoItem[];
  locationItems: LocationPlanItem[];
  totalRows: number;
  semSku: number;
  duplicadosSku: number;
}

function asStock(v: unknown): number {
  const n = asNumber(v);
  if (n === null) return 0;
  return Math.max(0, Math.floor(n));
}

export function mapIbrsoftProdutos(file: DetectedFile): IbrsoftProdutosResult {
  const produtos: IbrsoftProdutoItem[] = [];
  const seenSku = new Set<string>();
  let semSku = 0;
  let duplicadosSku = 0;
  const locPaths: Array<{ caminho: string | null }> = [];

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (l: string) => file.get(row, l);
    const linha = i + 1;

    const skuRaw = asString(get("codigo"));
    if (!skuRaw || skuRaw === "-1") {
      semSku++;
      continue;
    }
    const skuKey = skuRaw.trim().toLowerCase();
    if (seenSku.has(skuKey)) {
      duplicadosSku++;
      continue;
    }
    seenSku.add(skuKey);

    const rawLoc = asString(get("sigla_localizacao"));
    const locationCode = normPath(rawLoc);
    if (locationCode) locPaths.push({ caminho: rawLoc });

    const custo = asNumber(get("custo_compra"));
    produtos.push({
      linha,
      sku: skuRaw.trim(),
      name: asString(get("descricao")) ?? "(sem descrição)",
      price: asNumber(get("valor_venda")) ?? 0,
      cost: custo !== null && custo > 0.01 ? custo : null,
      stock: asStock(get("estoque")),
      brand: asString(get("marca")),
      model: asString(get("modelo")),
      ncm: asString(get("ncm")),
      barcode: asString(get("codigo_fabricante")),
      active: true,
      ibrProductId: null,
      locationCode,
      locationText: locationCode,
      scrapPlate: cleanPlate(get("placa")),
      scrapLote: asString(get("lote")),
    });
  }

  return {
    produtos,
    locationItems: buildIbrsoftLocationTree(locPaths),
    totalRows: file.rows.length,
    semSku,
    duplicadosSku,
  };
}

/* --------------------------------- NF-e -------------------------------- */

function mapIbrsoftNfeStatus(raw: string | null): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("cancel")) return "CANCELLED";
  if (s.includes("inutiliz")) return "INUTILIZED";
  if (s.includes("nega") || s.includes("denegad")) return "REJECTED";
  // Autorizada, Corrigida (CC-e) e afins = nota válida/autorizada.
  return "AUTHORIZED";
}

export interface IbrsoftNfeResult {
  items: NfePlanItem[];
  totalRows: number;
  semNumero: number;
  duplicadosColapsados: number;
  porStatus: Record<string, number>;
  semChave: number;
  cnpjsEmitentes: string[];
  avisos: ImportRowIssue[];
}

export function mapIbrsoftNfes(file: DetectedFile): IbrsoftNfeResult {
  const avisos: ImportRowIssue[] = [];
  const porStatus: Record<string, number> = {};
  const cnpjs = new Set<string>();
  let semNumero = 0;
  let semChave = 0;
  const bySerieNum = new Map<string, NfePlanItem>();

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (l: string) => file.get(row, l);
    const linha = i + 1;

    const numero = asInt(get("numero_nota"));
    if (numero === null) {
      semNumero++;
      continue;
    }
    const chaveRaw = onlyDigits(get("chave_acesso"));
    const chave = chaveRaw.length === 44 ? chaveRaw : null;
    if (!chave) {
      semChave++;
      addIssue(avisos, {
        linha,
        motivo: `NF-e ${numero}: chave de acesso inválida — importada sem chave`,
      });
    }
    const serie = chave
      ? parseInt(chave.slice(22, 25), 10)
      : (asInt(get("serie")) ?? 1);
    const dedupKey = `${serie}/${numero}`;
    if (bySerieNum.has(dedupKey)) continue;

    const cnpjEmitente = chave ? chave.slice(6, 20) : null;
    if (cnpjEmitente) cnpjs.add(cnpjEmitente);

    const status = mapIbrsoftNfeStatus(asString(get("status")));
    porStatus[status] = (porStatus[status] ?? 0) + 1;
    const tipo =
      (asString(get("tipo")) ?? "").toLowerCase().startsWith("entr")
        ? "ENTRADA"
        : "SAIDA";
    const natureza = asString(get("natureza_operacao"));
    const valor = asNumber(get("valor")) ?? 0;
    const dataEmissao = parseFlexibleDate(get("criado_em"));

    const infoParts = ["Import Dexo · NF-e histórica (IBR Soft)"];
    if (natureza) infoParts.push(natureza);
    const sit = asString(get("status"));
    if (sit) infoParts.push(sit);

    bySerieNum.set(dedupKey, {
      linha,
      numero,
      serie,
      chaveAcesso: chave,
      status,
      tipoOperacao: tipo,
      destinoOperacao: "INTERNA",
      naturezaOperacao: natureza ?? (tipo === "SAIDA" ? "VENDA" : "ENTRADA"),
      valor,
      dataEmissao,
      dataAutorizacao:
        status === "AUTHORIZED" || status === "CANCELLED" ? dataEmissao : null,
      nomeDestinatario: asString(get("destinatario")) ?? "",
      cnpjEmitente,
      informacoesComplementares: infoParts.join(" · "),
    });
  }

  const items = Array.from(bySerieNum.values()).sort(
    (a, b) => a.serie - b.serie || a.numero - b.numero,
  );
  return {
    items,
    totalRows: file.rows.length,
    semNumero,
    duplicadosColapsados: file.rows.length - bySerieNum.size - semNumero,
    porStatus,
    semChave,
    cnpjsEmitentes: [...cnpjs],
    avisos,
  };
}

/* -------------------------------- Contas ------------------------------- */

/**
 * Contas a pagar e a receber do IBR Soft. Pula as "Removida" (foram apagadas
 * no sistema de origem — não são contas reais). Conta quitada (valor pago ≥
 * inicial) entra como PAGA + paidAt; senão PENDENTE.
 */
export function mapIbrsoftContas(
  file: DetectedFile,
  kind: "payable" | "receivable",
): FinanceMapResult {
  const items: FinancePlanItem[] = [];
  const erros: ImportRowIssue[] = [];
  const avisos: ImportRowIssue[] = [];
  const hashOccurrences = new Map<string, number>();
  const pagoCol = kind === "payable" ? "valor_pago" : "valor_recebido";
  const nomeCol = kind === "payable" ? "favorecido" : "cliente";
  const docCol = kind === "payable" ? "documento_favorecido" : "documento_cliente";

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (l: string) => file.get(row, l);
    const linha = i + 1;

    // Conta apagada/estornada na origem — não é conta real. O IBR Soft
    // sinaliza de DUAS formas (colunas booleanas removida/estornada = "t" E
    // status textual "Removida"/"Estornada"); honra ambas.
    const statusRaw = (asString(get("status")) ?? "").toLowerCase();
    if (
      isTruthyFlag(get("removida")) ||
      isTruthyFlag(get("estornada")) ||
      statusRaw.includes("removid") ||
      statusRaw.includes("estorn")
    ) {
      avisos.push({ linha, motivo: `Linha ${linha}: conta removida/estornada ignorada` });
      continue;
    }

    const totalAmount = asNumber(get("valor_inicial"));
    if (totalAmount === null || totalAmount <= 0) {
      erros.push({ linha, motivo: "valor_inicial deve ser maior que zero" });
      continue;
    }
    const dueDate = parseFlexibleDate(get("vencimento"));
    if (!dueDate) {
      erros.push({ linha, motivo: "vencimento inválido" });
      continue;
    }

    const pago = asNumber(get(pagoCol)) ?? 0;
    const quitada = pago >= totalAmount - 0.001;
    const status = quitada ? "PAGA" : "PENDENTE";
    const paidAt = quitada
      ? (parseFlexibleDate(get("ultimo_pagamento")) ??
        parseFlexibleDate(get("ultimo_recebimento")) ??
        dueDate)
      : null;

    const docDigits = onlyDigits(get(docCol));
    const customerCpf =
      docDigits.length > 0 && docDigits.length <= 11 ? validCPF(docDigits) : null;
    const customerCnpj = docDigits.length > 11 ? validCNPJ(docDigits) : null;
    const customerName = asString(get(nomeCol));
    if (!customerCpf && !customerCnpj && !customerName) {
      erros.push({ linha, motivo: "conta sem favorecido/cliente identificável" });
      continue;
    }

    const document = asString(get("documento_conta"));
    const observacao = asString(get("observacao"));
    const installments = Math.max(1, asInt(get("total_parcelas")) ?? 1);
    const baseHash = shortLineHash([
      kind,
      document,
      docDigits || customerName,
      totalAmount,
      dueDate.toISOString().slice(0, 10),
      status,
      installments,
      observacao,
    ]);
    const occ = hashOccurrences.get(baseHash) ?? 0;
    hashOccurrences.set(baseHash, occ + 1);
    const markerHash = shortLineHash([baseHash, occ]);
    const reason = [observacao, importFinanceMarker(markerHash)]
      .filter((p): p is string => !!p)
      .join(" ");

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
      paymentMethod: null,
      installments,
      reason,
      markerHash,
    });
  }
  return { items, totalRows: file.rows.length, erros, avisos };
}
