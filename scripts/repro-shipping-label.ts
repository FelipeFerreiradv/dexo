/**
 * repro-shipping-label.ts
 *
 * Reproduz, SEM a UI, o passo `upload_invoice_doc` do fluxo de etiqueta de
 * envio da Shopee — o ponto onde o incidente de 29/07/2026 falha com
 * "Shopee upload_invoice_doc 404: Request failed with status code 404".
 *
 * Existe porque o catch de ShopeeApiService.uploadInvoiceDoc descarta a
 * evidência (body cru, request_id, headers, URL efetivamente chamada), então
 * era impossível distinguir "path errado" de "loja sem permissão de emissor
 * externo" ou "assinatura inválida" apenas pelos logs.
 *
 * Assina com o MESMO código de produção (ShopeeOAuthService.generateSignature)
 * e monta a URL do mesmo jeito que ShopeeApiService.buildSignedUrl, mas com o
 * módulo parametrizável — é isso que permite o A/B decisivo: dois requests
 * idênticos em tudo, exceto o segmento de módulo do path.
 *
 * Segredos (access_token, sign, partner_id, partner_key) são SEMPRE mascarados
 * na saída. A saída é feita para ser colada em relatório de incidente.
 *
 * Uso:
 *   npx tsx scripts/repro-shipping-label.ts --order=<cuid>
 *       Só diagnóstico (read-only). NÃO chama a Shopee.
 *
 *   npx tsx scripts/repro-shipping-label.ts --order=<cuid> --apply
 *       Chama a Shopee de verdade no path CORRETO (order).
 *
 *   npx tsx scripts/repro-shipping-label.ts --order=<cuid> --apply --ab
 *       A/B: chama logistics (o bug) E order (a correção), lado a lado.
 *
 *   Flags extras:
 *     --module=order|logistics   força um módulo específico (default: order)
 *     --body=multipart|base64    forma do corpo (default: multipart)
 *     --file-type=<valor>        default: normal_invoice
 */

import axios from "axios";
import FormData from "form-data";

import prisma from "../app/lib/prisma";
import { NfeRepository } from "../app/repositories/nfe.repository";
import { FiscalStorageService } from "../app/fiscal/storage/fiscal-storage.service";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { SHOPEE_CONSTANTS } from "../app/marketplaces/shopee/shopee-constants";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

type BodyShape = "multipart" | "base64";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const withEq = args.find((a) => a.startsWith(`--${name}=`));
    if (withEq) return withEq.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) {
      return args[i + 1];
    }
    return undefined;
  };
  return {
    orderId: get("order"),
    apply: args.includes("--apply"),
    ab: args.includes("--ab"),
    module: (get("module") ?? "order") as "order" | "logistics",
    body: (get("body") ?? "multipart") as BodyShape,
    fileType: get("file-type") ?? "normal_invoice",
    /** Nome do campo multipart do arquivo. O SDK cita `invoice_file`; o código atual manda `file`. */
    fileField: get("file-field") ?? "file",
    /** Qual artefato enviar: o XML autorizado ou o PDF do DANFE. */
    artifact: (get("artifact") ?? "xml") as "xml" | "pdf",
    /** Roda o pipeline de etiqueta (create → poll → download) após o upload. */
    label: args.includes("--label"),
  };
}

// ---------------------------------------------------------------------------
// sanitização — nada de segredo/PII na saída
// ---------------------------------------------------------------------------

const SECRET_QUERY_KEYS = ["access_token", "sign", "partner_id"];

/** Mostra só as pontas: "abcd…wxyz (48 ch)". Vazio => "<vazio>". */
function maskValue(value: string): string {
  if (!value) return "<vazio>";
  if (value.length <= 8) return `${"*".repeat(value.length)} (${value.length} ch)`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} ch)`;
}

/** Reescreve a URL mascarando os parâmetros sensíveis da query. */
function maskUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of SECRET_QUERY_KEYS) {
    const current = url.searchParams.get(key);
    if (current) url.searchParams.set(key, maskValue(current));
  }
  return decodeURIComponent(url.toString());
}

/** CPF/CNPJ e telefones longos que possam vir no corpo de resposta. */
function scrubPii(text: string): string {
  return text
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "<CPF-REMOVIDO>")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "<CNPJ-REMOVIDO>")
    .replace(/\b\d{10,13}\b/g, "<NUM-REMOVIDO>");
}

function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} ch]`;
}

/** Body de resposta -> string legível e sanitizada, seja JSON, texto ou binário. */
function renderResponseBody(data: unknown): string {
  if (data == null) return "<vazio>";
  if (Buffer.isBuffer(data)) {
    return `<binário ${data.length} bytes> ${truncate(data.toString("utf-8"), 500)}`;
  }
  const asText = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return truncate(scrubPii(asText));
}

// ---------------------------------------------------------------------------
// chamada
// ---------------------------------------------------------------------------

interface CallResult {
  module: string;
  url: string;
  httpStatus: number | null;
  providerError: string | null;
  providerMessage: string | null;
  requestId: string | null;
  body: string;
  durationMs: number;
}

/**
 * Monta a URL assinada exatamente como ShopeeApiService.buildSignedUrl, porém
 * com o módulo parametrizável. Reusa a assinatura REAL de produção — se a
 * assinatura estivesse errada, este script erraria junto (é o que se quer).
 */
function buildSignedUrl(apiPath: string, accessToken: string, shopId: number): string {
  const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
  const timestamp = Math.floor(Date.now() / 1000);
  // A Shopee assina o PATH, sem query string.
  const pathOnly = apiPath.split("?")[0];
  const signature = ShopeeOAuthService.generateSignature({
    partner_id: partnerId,
    api_path: pathOnly,
    timestamp,
    access_token: accessToken,
    shop_id: shopId,
  });
  const url = new URL(apiPath, SHOPEE_CONSTANTS.API_URL);
  url.searchParams.set("partner_id", partnerId.toString());
  url.searchParams.set("timestamp", timestamp.toString());
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("shop_id", shopId.toString());
  url.searchParams.set("sign", signature);
  return url.toString();
}

async function callUploadInvoiceDoc(opts: {
  module: "order" | "logistics";
  bodyShape: BodyShape;
  fileType: string;
  fileField: string;
  accessToken: string;
  shopId: number;
  orderSn: string;
  /** Conteúdo do arquivo a enviar (XML autorizado ou PDF do DANFE). */
  fileBuf: Buffer;
  fileName: string;
  fileMime: string;
}): Promise<CallResult> {
  const apiPath = `/api/v2/${opts.module}/upload_invoice_doc`;
  const url = buildSignedUrl(apiPath, opts.accessToken, opts.shopId);

  let payload: unknown;
  let headers: Record<string, string> = {};
  if (opts.bodyShape === "multipart") {
    const form = new FormData();
    form.append("order_sn", opts.orderSn);
    form.append("file_type", opts.fileType);
    form.append(opts.fileField, opts.fileBuf, {
      filename: opts.fileName,
      contentType: opts.fileMime,
    });
    payload = form;
    headers = form.getHeaders();
  } else {
    payload = {
      order_sn: opts.orderSn,
      file_type: opts.fileType,
      [opts.fileField]: opts.fileBuf.toString("base64"),
    };
    headers = { "Content-Type": "application/json" };
  }

  console.log(`\n  → POST ${maskUrl(url)}`);
  console.log(`    corpo: ${opts.bodyShape}`);
  console.log(
    `      order_sn=${opts.orderSn}  file_type=${opts.fileType}  ${opts.fileField}=${opts.fileBuf.length} bytes` +
      ` (${opts.fileName}, ${opts.fileMime})`,
  );
  console.log(
    `    headers: ${Object.entries(headers)
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
      .join(", ")}`,
  );

  const startedAt = Date.now();
  try {
    const resp = await axios.post(url, payload, {
      headers,
      timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
      // Queremos VER o 404, não deixar o axios convertê-lo em exceção.
      validateStatus: () => true,
    });
    const data = resp.data as Record<string, unknown> | undefined;
    return {
      module: opts.module,
      url: maskUrl(url),
      httpStatus: resp.status,
      providerError: (data?.error as string) ?? null,
      providerMessage: (data?.message as string) ?? null,
      requestId: (data?.request_id as string) ?? null,
      body: renderResponseBody(resp.data),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // Só cai aqui em erro de transporte (DNS, timeout, TLS) — validateStatus
    // acima já absorve qualquer status HTTP.
    const axErr = axios.isAxiosError(error) ? error : null;
    return {
      module: opts.module,
      url: maskUrl(url),
      httpStatus: axErr?.response?.status ?? null,
      providerError: axErr?.code ?? null,
      providerMessage: error instanceof Error ? error.message : String(error),
      requestId: null,
      body: renderResponseBody(axErr?.response?.data),
      durationMs: Date.now() - startedAt,
    };
  }
}

function printResult(r: CallResult): void {
  const verdict =
    r.httpStatus === 200 && !r.providerError
      ? "✅ SUCESSO"
      : r.httpStatus === 404
        ? "❌ 404 — rota inexistente no gateway"
        : `⚠️  status ${r.httpStatus}`;
  console.log(`\n  ← ${verdict}  (${r.durationMs} ms)`);
  console.log(`    http_status : ${r.httpStatus}`);
  console.log(`    error       : ${r.providerError ?? "<nenhum>"}`);
  console.log(`    message     : ${r.providerMessage ?? "<nenhum>"}`);
  console.log(`    request_id  : ${r.requestId ?? "<nenhum>"}`);
  console.log(`    body        : ${r.body}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function run() {
  const args = parseArgs();
  if (!args.orderId) {
    console.error(
      "Uso: npx tsx scripts/repro-shipping-label.ts --order=<cuid> [--apply] [--ab]",
    );
    process.exit(1);
  }

  console.log("=".repeat(78));
  console.log("REPRO — Shopee upload_invoice_doc");
  console.log("=".repeat(78));
  console.log(`orderId   : ${args.orderId}`);
  console.log(`modo      : ${args.apply ? (args.ab ? "APPLY + A/B" : "APPLY") : "DIAGNÓSTICO (sem rede)"}`);
  console.log(`API_URL   : ${SHOPEE_CONSTANTS.API_URL}`);
  console.log(`sandbox   : ${process.env.SHOPEE_SANDBOX ?? "<não definido>"}`);
  console.log(`partner_id: ${maskValue(SHOPEE_CONSTANTS.PARTNER_ID ?? "")}`);
  console.log(`partner_key: ${maskValue(SHOPEE_CONSTANTS.PARTNER_KEY ?? "")}`);

  // --- 1. pedido + conta -----------------------------------------------------
  const order = await prisma.order.findUnique({
    where: { id: args.orderId },
    select: {
      id: true,
      externalOrderId: true,
      status: true,
      totalAmount: true,
      createdAt: true,
      soldAt: true,
      marketplaceAccount: {
        select: {
          id: true,
          platform: true,
          accountName: true,
          shopId: true,
          accessToken: true,
          refreshToken: true,
          expiresAt: true,
          userId: true,
        },
      },
      shipmentLabel: true,
    },
  });

  if (!order) {
    console.error(`\n❌ Pedido ${args.orderId} não existe neste banco.`);
    process.exit(1);
  }
  const acc = order.marketplaceAccount;

  console.log("\n--- PEDIDO ---------------------------------------------------");
  console.log(`order_sn (externalOrderId): ${order.externalOrderId}`);
  console.log(`status                    : ${order.status}`);
  console.log(`total                     : ${order.totalAmount}`);
  console.log(`soldAt / createdAt        : ${order.soldAt?.toISOString() ?? "—"} / ${order.createdAt.toISOString()}`);
  console.log(`conta                     : ${acc.accountName} (${acc.platform})`);
  console.log(`shopId                    : ${acc.shopId ?? "<NULO>"}`);
  console.log(`token expira em           : ${acc.expiresAt?.toISOString() ?? "—"}`);
  console.log(`access_token              : ${maskValue(acc.accessToken ?? "")}`);

  console.log("\n--- ETIQUETA (ShipmentLabel) ---------------------------------");
  if (!order.shipmentLabel) {
    console.log("nenhum registro");
  } else {
    const l = order.shipmentLabel;
    console.log(`labelStatus  : ${l.labelStatus}`);
    console.log(`labelSize    : ${l.labelSize ?? "—"}`);
    console.log(`invoiceSentAt: ${l.invoiceSentAt?.toISOString() ?? "—"}`);
    console.log(`labelPdfPath : ${l.labelPdfPath ?? "—"}`);
    console.log(`labelError   : ${l.labelError ?? "—"}`);
    console.log(`updatedAt    : ${l.updatedAt.toISOString()}`);
  }

  // --- 2. NF-e ---------------------------------------------------------------
  const nfeRepo = new NfeRepository();
  const prodNfe = await nfeRepo.findAuthorizedByOrderId(acc.userId, order.id, "PRODUCAO");

  console.log("\n--- NF-e -----------------------------------------------------");
  if (!prodNfe) {
    console.log("❌ SEM NF-e autorizada de PRODUÇÃO — o fluxo pararia em NFE_NOT_FOUND.");
    await prisma.$disconnect();
    return;
  }
  // findAuthorizedByOrderId devolve um shape estreito (é o que o usecase usa);
  // para o diagnóstico completo lemos os campos extras direto.
  const nfeDetail = await prisma.nfeEmitida.findUnique({
    where: { id: prodNfe.id },
    select: {
      serie: true,
      numero: true,
      dataAutorizacao: true,
      danfePdfPath: true,
      protocoloAutorizacao: true,
    },
  });

  console.log(`id            : ${prodNfe.id}`);
  console.log(
    `modelo/série/nº: ${prodNfe.modelo} / ${nfeDetail?.serie ?? "?"} / ${nfeDetail?.numero ?? "?"}`,
  );
  console.log(`status        : ${prodNfe.status}`);
  console.log(`autorizada em : ${nfeDetail?.dataAutorizacao?.toISOString() ?? "—"}`);
  console.log(`protocolo     : ${nfeDetail?.protocoloAutorizacao ?? "—"}`);
  console.log(
    `chaveAcesso   : ${prodNfe.chaveAcesso ? `${prodNfe.chaveAcesso.slice(0, 6)}…${prodNfe.chaveAcesso.slice(-4)}` : "—"}`,
  );
  console.log(`xmlAutorizado : ${prodNfe.xmlAutorizadoPath ?? "<NULO>"}`);
  console.log(`danfePdfPath  : ${nfeDetail?.danfePdfPath ?? "<NULO>"}`);

  if (!prodNfe.xmlAutorizadoPath) {
    console.log("\n❌ xmlAutorizadoPath nulo — o fluxo pararia em NFE_XML_MISSING.");
    await prisma.$disconnect();
    return;
  }

  const storage = new FiscalStorageService();
  const xmlBuf = await storage.readFile(prodNfe.xmlAutorizadoPath);
  if (!xmlBuf) {
    console.log("\n❌ Arquivo do XML não encontrado no disco — pararia em NFE_XML_MISSING.");
    await prisma.$disconnect();
    return;
  }
  const xml = xmlBuf.toString("utf-8");
  const looksLikeXml = xml.trimStart().startsWith("<");
  console.log(`arquivo XML   : ${xmlBuf.length} bytes — ${looksLikeXml ? "começa com '<' ✅" : "⚠️ NÃO começa com '<' (JSON travestido de XML?)"}`);
  console.log(`primeiros 80  : ${xml.slice(0, 80).replace(/\s+/g, " ")}`);

  // --- 3. chamada ------------------------------------------------------------
  if (!args.apply) {
    console.log(
      "\n(diagnóstico apenas — nenhuma chamada à Shopee. Use --apply para reproduzir.)",
    );
    await prisma.$disconnect();
    return;
  }

  if (acc.shopId == null) {
    console.error("\n❌ Conta sem shopId — impossível assinar.");
    await prisma.$disconnect();
    process.exit(1);
  }

  // Qual artefato vai no corpo: o XML autorizado (o que o código faz hoje) ou o
  // PDF do DANFE — é uma das variáveis em aberto do contrato da Shopee.
  let fileBuf = xmlBuf;
  let fileName = `${order.externalOrderId}.xml`;
  let fileMime = "application/xml";
  if (args.artifact === "pdf") {
    if (!nfeDetail?.danfePdfPath) {
      console.error("\n❌ --artifact=pdf pedido, mas a NF-e não tem danfePdfPath.");
      await prisma.$disconnect();
      process.exit(1);
    }
    const pdfBuf = await storage.readFile(nfeDetail.danfePdfPath);
    if (!pdfBuf) {
      console.error("\n❌ PDF do DANFE não encontrado no disco.");
      await prisma.$disconnect();
      process.exit(1);
    }
    fileBuf = pdfBuf;
    fileName = `${order.externalOrderId}.pdf`;
    fileMime = "application/pdf";
    console.log(`\nartefato      : DANFE PDF (${pdfBuf.length} bytes)`);
  }

  const common = {
    bodyShape: args.body,
    fileType: args.fileType,
    fileField: args.fileField,
    accessToken: acc.accessToken,
    shopId: acc.shopId,
    orderSn: order.externalOrderId,
    fileBuf,
    fileName,
    fileMime,
  };

  const modules: Array<"order" | "logistics"> = args.ab
    ? ["logistics", "order"]
    : [args.module];

  const results: CallResult[] = [];
  for (const mod of modules) {
    console.log(`\n${"─".repeat(78)}`);
    console.log(
      `MÓDULO "${mod}" ${mod === "logistics" ? "(o que está em produção hoje — esperado 404)" : "(o path oficial)"}`,
    );
    console.log("─".repeat(78));
    const r = await callUploadInvoiceDoc({ ...common, module: mod });
    printResult(r);
    results.push(r);
  }

  // --- 4. pipeline de etiqueta ----------------------------------------------
  // Roda create → poll → download usando os métodos REAIS de produção. Serve
  // para responder: o upload da NF-e recusado bloqueia a etiqueta, ou a
  // etiqueta sai mesmo assim? É o que decide se a falha do invoice deve ser
  // tratada como não-bloqueante.
  if (args.label) {
    console.log(`\n${"─".repeat(78)}`);
    console.log("PIPELINE DE ETIQUETA (create → poll → download)");
    console.log("─".repeat(78));
    const orderList = [{ order_sn: order.externalOrderId }];
    const docType = "NORMAL_AIR_WAYBILL";
    try {
      const param = await ShopeeApiService.getShippingParameter(
        acc.accessToken,
        acc.shopId,
        order.externalOrderId,
      );
      console.log(`  get_shipping_parameter → ${truncate(JSON.stringify(param), 300)}`);
    } catch (e) {
      console.log(`  get_shipping_parameter ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await ShopeeApiService.createShippingDocument(
        acc.accessToken,
        acc.shopId,
        orderList,
        docType,
      );
      console.log("  create_shipping_document ✅");
    } catch (e) {
      console.log(`  create_shipping_document ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await ShopeeApiService.getShippingDocumentResult(
          acc.accessToken,
          acc.shopId,
          orderList,
          docType,
        );
        console.log(`  poll #${i + 1} → ${JSON.stringify(res)}`);
        if (res.length && res.every((r) => r.status === "READY")) break;
      } catch (e) {
        console.log(`  poll #${i + 1} ✗ ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    try {
      const pdf = await ShopeeApiService.downloadShippingDocument(
        acc.accessToken,
        acc.shopId,
        orderList,
        docType,
      );
      const isPdf = pdf.subarray(0, 4).toString() === "%PDF";
      console.log(
        `  download_shipping_document → ${pdf.length} bytes, ${isPdf ? "✅ é PDF" : `⚠️ NÃO é PDF: ${truncate(pdf.toString("utf-8"), 200)}`}`,
      );
    } catch (e) {
      console.log(`  download_shipping_document ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (results.length > 1) {
    console.log(`\n${"=".repeat(78)}`);
    console.log("A/B — mesma assinatura, mesmo corpo, só muda o módulo do path");
    console.log("=".repeat(78));
    for (const r of results) {
      console.log(
        `  /api/v2/${r.module.padEnd(9)}/upload_invoice_doc → HTTP ${r.httpStatus}  error=${r.providerError ?? "—"}  request_id=${r.requestId ?? "—"}`,
      );
    }
  }

  await prisma.$disconnect();
}

run().catch(async (error) => {
  console.error("\n❌ Erro inesperado:", error);
  await prisma.$disconnect();
  process.exit(1);
});
