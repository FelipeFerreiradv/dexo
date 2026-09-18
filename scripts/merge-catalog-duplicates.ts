import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Prisma } from "@prisma/client";

import prisma from "../app/lib/prisma";
import { CATALOG_PRODUCT_MERGE_LOCK_KEY } from "../app/marketplaces/lib/catalog-merge-lock";
import { isSaleLikeStockLogReason } from "../app/marketplaces/lib/sale-like-stock-log";

const APPLY_FLAGS = new Set(["--apply", "--confirmar", "--allow-any-host"]);
const VALUE_FLAGS = new Set([
  "--manifest",
  "--identity-seed",
  "--user-email",
  "--sha256",
  "--identity-sha256",
]);
const IDENTITY_STATUSES = new Set<IdentityStatus>([
  "CONFIRMED",
  "AMBIGUOUS",
  "OBSERVED",
]);

export interface MergeCliOptions {
  manifestPath: string;
  identitySeedPath: string;
  userEmail: string;
  apply: boolean;
  confirmar: boolean;
  allowAnyHost: boolean;
  sha256?: string;
  identitySha256?: string;
}

export interface ManifestDonorStock {
  productId: string;
  stock: number;
}

export interface ManifestStockLog {
  id: string;
  productId: string;
  change: number;
  reason: string;
  previousStock: number;
  newStock: number;
  createdAt: string;
}

export interface ManifestStockSyncJob {
  id: string;
  productId: string;
  listingId: string;
  platform: string;
  targetStock: number;
  attempts: number;
  nextRunAt: string;
  status: string;
  lastError: string | null;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergeManifestGroup {
  ownerId: string;
  duplicateIds: string[];
  name: string;
  exactNormalizedTitle: true;
  exactFullGallery: boolean;
  sourceCode: string | null;
  externalSkus: string[];
  expected: {
    ownerStockUnchanged: number;
    donorStocksNotSummed: ManifestDonorStock[];
    reservedTotal: number;
    donorBlockingHistoryTotal: number;
    donorStockLogsToReparent: number;
    donorStockLogs: ManifestStockLog[];
    stockSyncJobsTouched: ManifestStockSyncJob[];
    listingIdsToMove: string[];
  };
  evidence: {
    photoIds: string[];
    galleryIdentities: Array<{
      platform: string;
      identityKey: string;
      imageIds: string[];
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MergeManifest {
  version: 1;
  tenant: string;
  tenantId: string;
  groups: MergeManifestGroup[];
  [key: string]: unknown;
}

type IdentityStatus = "CONFIRMED" | "AMBIGUOUS" | "OBSERVED";

export interface IdentitySeedRow {
  platform: string;
  identityKey: string;
  productId: string | null;
  status: IdentityStatus;
  sellerSkus: string[];
  evidence?: {
    observations: number;
    originalProductIds: string[];
    sources: string[];
  };
}

export interface IdentitySeed {
  version: 1;
  tenant: string;
  tenantId: string;
  identities: IdentitySeedRow[];
  [key: string]: unknown;
}

export interface ValidationIssue {
  code: string;
  message: string;
  ownerId?: string;
  productId?: string;
  expected?: unknown;
  actual?: unknown;
}

interface LockedProduct {
  id: string;
  userId: string | null;
  name: string;
  stock: number;
  reservedStock: number;
  autoCreatedFromSale: boolean;
  scrapId: string | null;
  attributes: unknown;
  imageUrl: string | null;
  imageUrls: string[];
}

export interface LiveListing {
  id: string;
  productId: string;
  marketplaceAccountId: string;
  externalListingId: string;
  externalSku: string | null;
  platform: string;
  accountDataOwnerId: string;
}

interface StockLogGuard {
  id: string;
  productId: string;
  change: number;
  reason: string;
  previousStock: number;
  newStock: number;
  createdAt: Date;
}

interface StockSyncJobGuard {
  id: string;
  productId: string;
  listingId: string;
  platform: string;
  targetStock: number;
  attempts: number;
  nextRunAt: Date;
  status: string;
  lastError: string | null;
  orderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  listingProductId: string | null;
  listingPlatform: string | null;
  accountDataOwnerId: string | null;
}

interface ExistingIdentity {
  userId: string;
  platform: string;
  identityKey: string;
  productId: string | null;
  status: string;
}

interface TransactionResult {
  validationErrors: ValidationIssue[];
  backup?: { file: string; sha256: string; rows: Record<string, number> };
  applied?: {
    groups: number;
    donorsDeleted: number;
    moved: Record<string, number>;
    identitiesSeeded: number;
    donorTombstonesSeeded: number;
    listingsQueued: number;
  };
  verification?: Record<string, unknown>;
  commitAudit?: {
    id: string;
    action: "CATALOG_DUPLICATE_MERGE_COMMITTED";
    manifestSha256: string;
  };
  phases: Array<{ phase: string; status: string; detail?: unknown }>;
}

interface CommitAuditLookupRow {
  id: string;
  userId: string;
  action: string;
  resource: string | null;
  resourceId: string | null;
  details: unknown;
}

type CommitOutcome = "committed" | "rolled-back" | "unknown";

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function reconcileCommitOutcome(
  input: {
    auditId: string;
    tenantId: string;
    manifestSha256: string;
    identitySeedSha256: string;
  },
  lookup: (auditId: string) => Promise<CommitAuditLookupRow[]> = (auditId) =>
    prisma.$queryRaw<CommitAuditLookupRow[]>`
      SELECT id, "userId", action::text AS action, resource, "resourceId", details
        FROM "SystemLog"
       WHERE id = ${auditId}
    `,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<CommitOutcome> {
  let absentLookups = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rows = await lookup(input.auditId);
      if (rows.length === 0) {
        absentLookups++;
        if (absentLookups === 3) return "rolled-back";
        if (attempt === 2) return "unknown";
        await pause(250 * (attempt + 1));
        continue;
      }
      if (rows.length !== 1) return "unknown";
      const row = rows[0];
      const details = isRecord(row.details) ? row.details : null;
      return row.id === input.auditId &&
        row.userId === input.tenantId &&
        row.action === "CATALOG_DUPLICATE_MERGE_COMMITTED" &&
        row.resource === "CatalogMergeManifest" &&
        row.resourceId === input.manifestSha256 &&
        details?.manifestSha256 === input.manifestSha256 &&
        details?.identitySeedSha256 === input.identitySeedSha256
        ? "committed"
        : "unknown";
    } catch {
      if (attempt === 2) return "unknown";
      await pause(250 * (attempt + 1));
    }
  }
  return "unknown";
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CliError("INVALID_INPUT", `${label} deve ser texto não vazio.`);
  }
  return value.trim();
}

function asInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new CliError(
      "INVALID_INPUT",
      `${label} deve ser inteiro >= ${minimum}.`,
    );
  }
  return Number(value);
}

function asSignedInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new CliError("INVALID_INPUT", `${label} deve ser inteiro.`);
  }
  return Number(value);
}

function asNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return asNonEmptyString(value, label);
}

function asIsoDate(value: unknown, label: string): string {
  const input = asNonEmptyString(value, label);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new CliError("INVALID_INPUT", `${label} deve ser uma data válida.`);
  }
  return date.toISOString();
}

function asUniqueStrings(
  value: unknown,
  label: string,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value))
    throw new CliError("INVALID_INPUT", `${label} deve ser uma lista.`);
  const result = value.map((entry, index) =>
    asNonEmptyString(entry, `${label}[${index}]`),
  );
  if (!allowEmpty && result.length === 0) {
    throw new CliError("INVALID_INPUT", `${label} não pode estar vazio.`);
  }
  if (new Set(result).size !== result.length) {
    throw new CliError("INVALID_INPUT", `${label} contém valores repetidos.`);
  }
  return result;
}

export function parseMergeCliArgs(argv: string[]): MergeCliOptions {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (const argument of argv) {
    const equal = argument.indexOf("=");
    const flag = equal >= 0 ? argument.slice(0, equal) : argument;
    if (APPLY_FLAGS.has(flag)) {
      if (equal >= 0)
        throw new CliError("INVALID_FLAG", `${flag} não recebe valor.`);
      if (booleans.has(flag))
        throw new CliError(
          "DUPLICATE_FLAG",
          `${flag} foi informado mais de uma vez.`,
        );
      booleans.add(flag);
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      if (equal < 0 || !argument.slice(equal + 1).trim()) {
        throw new CliError(
          "INVALID_FLAG",
          `${flag} exige valor no formato ${flag}=valor.`,
        );
      }
      if (values.has(flag))
        throw new CliError(
          "DUPLICATE_FLAG",
          `${flag} foi informado mais de uma vez.`,
        );
      values.set(flag, argument.slice(equal + 1).trim());
      continue;
    }
    throw new CliError("UNKNOWN_FLAG", `Flag não reconhecida: ${argument}`);
  }

  const manifestPath = values.get("--manifest");
  const identitySeedPath = values.get("--identity-seed");
  const userEmail = values.get("--user-email");
  if (!manifestPath || !identitySeedPath || !userEmail) {
    throw new CliError(
      "MISSING_FLAG",
      "Uso: --manifest=<json> --identity-seed=<json> --user-email=<email> [--apply --confirmar --sha256=<hash> --identity-sha256=<hash>] [--allow-any-host]",
    );
  }
  if (!/^\S+@\S+\.\S+$/.test(userEmail)) {
    throw new CliError(
      "INVALID_EMAIL",
      "--user-email não contém um e-mail válido.",
    );
  }
  const apply = booleans.has("--apply");
  const confirmar = booleans.has("--confirmar");
  const digest = values.get("--sha256");
  const identityDigest = values.get("--identity-sha256");
  if (digest && !/^[a-f0-9]{64}$/.test(digest)) {
    throw new CliError(
      "INVALID_SHA256",
      "--sha256 deve conter 64 caracteres hexadecimais minúsculos.",
    );
  }
  if (identityDigest && !/^[a-f0-9]{64}$/.test(identityDigest)) {
    throw new CliError(
      "INVALID_IDENTITY_SHA256",
      "--identity-sha256 deve conter 64 caracteres hexadecimais minúsculos.",
    );
  }
  if (apply && (!confirmar || !digest || !identityDigest)) {
    throw new CliError(
      "APPLY_NOT_CONFIRMED",
      "Apply exige --apply --confirmar, --sha256 e --identity-sha256 com os hashes exatos.",
    );
  }
  if (!apply && (confirmar || digest || identityDigest)) {
    throw new CliError(
      "DRY_RUN_WITH_APPLY_FLAGS",
      "--confirmar/--sha256/--identity-sha256 só podem ser usados junto com --apply.",
    );
  }
  return {
    manifestPath: path.resolve(manifestPath),
    identitySeedPath: path.resolve(identitySeedPath),
    userEmail: userEmail.toLowerCase(),
    apply,
    confirmar,
    allowAnyHost: booleans.has("--allow-any-host"),
    sha256: digest,
    identitySha256: identityDigest,
  };
}

export function normalizeManifestName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export { isSaleLikeStockLogReason };

export function canonicalManifestPhoto(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  const canonicalMl = input.match(/^ml:(\d+-ml[a-z]\d+_\d+)$/i);
  if (canonicalMl) return `ml:${canonicalMl[1].toLowerCase()}`;
  const canonicalShopee = input.match(/^shopee:(\/file\/[a-z0-9-]+)(?:_tn)?$/i);
  if (canonicalShopee) return `shopee:${canonicalShopee[1].toLowerCase()}`;
  const canonicalVaapt = input.match(
    /^vaapt:(\/(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9._~%+/-]+)$/i,
  );
  if (canonicalVaapt) return `vaapt:${canonicalVaapt[1]}`;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (/(^|\.)mlstatic\.com$/i.test(url.hostname)) {
      const ml = url.pathname.match(
        /(?:^|\/)D_(\d+-ML[A-Z]\d+_\d+)-[A-Z]\.(?:jpg|jpeg|png|webp)$/i,
      );
      return ml ? `ml:${ml[1].toLowerCase()}` : null;
    }
    if (
      /(^|\.)shopee\.(?:com\.br|com|sg)$/i.test(url.hostname) ||
      /(^|\.)img\.susercontent\.com$/i.test(url.hostname)
    ) {
      const shopee = url.pathname.match(/^\/file\/([a-z0-9-]+)(?:_tn)?$/i);
      return shopee ? `shopee:/file/${shopee[1].toLowerCase()}` : null;
    }
    if (
      /^recycleapp-images(?:-[a-z0-9-]+)*\.s3\.amazonaws\.com$/i.test(
        url.hostname,
      ) &&
      /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9._~%+/-]+$/i.test(url.pathname)
    ) {
      return `vaapt:${url.pathname}`;
    }
  } catch {
    return null;
  }
  return null;
}

function attributeText(value: unknown): string {
  if (isRecord(value)) return String(value.value_name ?? "").trim();
  return String(value ?? "").trim();
}

function liveSourceCode(attributes: unknown): string {
  if (!isRecord(attributes)) return "";
  return attributeText(attributes.codPeca || attributes.legacyPecaCode);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function stockLogEvidenceKey(row: ManifestStockLog): string {
  return JSON.stringify([
    row.id,
    row.productId,
    row.change,
    row.reason,
    row.previousStock,
    row.newStock,
    new Date(row.createdAt).toISOString(),
  ]);
}

function stockSyncJobEvidenceKey(row: ManifestStockSyncJob): string {
  return JSON.stringify([
    row.id,
    row.productId,
    row.listingId,
    row.platform,
    row.targetStock,
    row.attempts,
    new Date(row.nextRunAt).toISOString(),
    row.status,
    row.lastError,
    row.orderId,
    new Date(row.createdAt).toISOString(),
    new Date(row.updatedAt).toISOString(),
  ]);
}

export function parseMergeManifest(value: unknown): MergeManifest {
  if (!isRecord(value) || value.version !== 1) {
    throw new CliError(
      "INVALID_MANIFEST",
      "Manifesto deve ser objeto com version=1.",
    );
  }
  const tenant = asNonEmptyString(value.tenant, "manifest.tenant");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant)) {
    throw new CliError(
      "INVALID_MANIFEST",
      "manifest.tenant deve ser um slug seguro com até 64 caracteres.",
    );
  }
  const tenantId = asNonEmptyString(value.tenantId, "manifest.tenantId");
  if (!Array.isArray(value.groups) || value.groups.length === 0) {
    throw new CliError(
      "INVALID_MANIFEST",
      "manifest.groups deve conter ao menos um grupo.",
    );
  }
  const seenProducts = new Set<string>();
  const seenListings = new Set<string>();
  const seenGalleryIdentities = new Set<string>();
  const groups: MergeManifestGroup[] = value.groups.map((raw, groupIndex) => {
    if (!isRecord(raw))
      throw new CliError("INVALID_MANIFEST", `groups[${groupIndex}] inválido.`);
    const ownerId = asNonEmptyString(
      raw.ownerId,
      `groups[${groupIndex}].ownerId`,
    );
    const duplicateIds = asUniqueStrings(
      raw.duplicateIds,
      `groups[${groupIndex}].duplicateIds`,
      false,
    );
    if (duplicateIds.includes(ownerId))
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} inclui o owner como donor.`,
      );
    for (const id of [ownerId, ...duplicateIds]) {
      if (seenProducts.has(id))
        throw new CliError(
          "INVALID_MANIFEST",
          `Produto ${id} aparece em mais de um grupo.`,
        );
      seenProducts.add(id);
    }
    const name = asNonEmptyString(raw.name, `groups[${groupIndex}].name`);
    if (
      raw.exactNormalizedTitle !== true ||
      typeof raw.exactFullGallery !== "boolean"
    ) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} não declara identidade exata de título/galeria.`,
      );
    }
    const sourceCode =
      raw.sourceCode === null
        ? null
        : asNonEmptyString(raw.sourceCode, `groups[${groupIndex}].sourceCode`);
    const externalSkus = asUniqueStrings(
      raw.externalSkus,
      `groups[${groupIndex}].externalSkus`,
    ).map((sku) => sku.toUpperCase());
    if (new Set(externalSkus).size !== externalSkus.length) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} contém SKUs externos repetidos após normalização.`,
      );
    }
    if (!isRecord(raw.expected))
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} não possui expected.`,
      );
    const expectedDonorsRaw = raw.expected.donorStocksNotSummed;
    if (!Array.isArray(expectedDonorsRaw))
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId}: donorStocksNotSummed inválido.`,
      );
    const donorStocksNotSummed = expectedDonorsRaw.map((entry, index) => {
      if (!isRecord(entry))
        throw new CliError(
          "INVALID_MANIFEST",
          `Grupo ${ownerId}: donor stock ${index} inválido.`,
        );
      return {
        productId: asNonEmptyString(
          entry.productId,
          `Grupo ${ownerId}: donorStocks[${index}].productId`,
        ),
        stock: asInteger(
          entry.stock,
          `Grupo ${ownerId}: donorStocks[${index}].stock`,
        ),
      };
    });
    const donorStockIds = donorStocksNotSummed.map((entry) => entry.productId);
    if (!arraysEqual(sortedUnique(donorStockIds), sortedUnique(duplicateIds))) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId}: estoques esperados não cobrem exatamente os donors.`,
      );
    }
    if (!Array.isArray(raw.expected.donorStockLogs)) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId}: donorStockLogs deve ser uma lista assinada.`,
      );
    }
    const seenStockLogs = new Set<string>();
    const donorStockLogs = raw.expected.donorStockLogs
      .map((entry, index) => {
        if (!isRecord(entry)) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: donorStockLogs[${index}] inválido.`,
          );
        }
        const id = asNonEmptyString(
          entry.id,
          `Grupo ${ownerId}: donorStockLogs[${index}].id`,
        );
        const productId = asNonEmptyString(
          entry.productId,
          `Grupo ${ownerId}: donorStockLogs[${index}].productId`,
        );
        if (seenStockLogs.has(id) || !duplicateIds.includes(productId)) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: StockLog ${id} repetido ou fora dos donors.`,
          );
        }
        seenStockLogs.add(id);
        const createdAtInput = asNonEmptyString(
          entry.createdAt,
          `Grupo ${ownerId}: donorStockLogs[${index}].createdAt`,
        );
        const createdAtDate = new Date(createdAtInput);
        if (Number.isNaN(createdAtDate.getTime())) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: donorStockLogs[${index}].createdAt inválido.`,
          );
        }
        return {
          id,
          productId,
          change: asSignedInteger(
            entry.change,
            `Grupo ${ownerId}: donorStockLogs[${index}].change`,
          ),
          reason: asNonEmptyString(
            entry.reason,
            `Grupo ${ownerId}: donorStockLogs[${index}].reason`,
          ),
          previousStock: asInteger(
            entry.previousStock,
            `Grupo ${ownerId}: donorStockLogs[${index}].previousStock`,
          ),
          newStock: asInteger(
            entry.newStock,
            `Grupo ${ownerId}: donorStockLogs[${index}].newStock`,
          ),
          createdAt: createdAtDate.toISOString(),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!Array.isArray(raw.expected.stockSyncJobsTouched)) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId}: stockSyncJobsTouched deve ser uma lista assinada.`,
      );
    }
    const seenStockSyncJobs = new Set<string>();
    const stockSyncJobsTouched = raw.expected.stockSyncJobsTouched
      .map((entry, index) => {
        if (!isRecord(entry)) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}] inválido.`,
          );
        }
        const id = asNonEmptyString(
          entry.id,
          `Grupo ${ownerId}: stockSyncJobsTouched[${index}].id`,
        );
        const productId = asNonEmptyString(
          entry.productId,
          `Grupo ${ownerId}: stockSyncJobsTouched[${index}].productId`,
        );
        if (
          seenStockSyncJobs.has(id) ||
          ![ownerId, ...duplicateIds].includes(productId)
        ) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: StockSyncJob ${id} repetido ou fora do grupo.`,
          );
        }
        seenStockSyncJobs.add(id);
        const platform = asNonEmptyString(
          entry.platform,
          `Grupo ${ownerId}: stockSyncJobsTouched[${index}].platform`,
        ).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(platform)) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: StockSyncJob ${id} possui plataforma inválida.`,
          );
        }
        return {
          id,
          productId,
          listingId: asNonEmptyString(
            entry.listingId,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].listingId`,
          ),
          platform,
          targetStock: asInteger(
            entry.targetStock,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].targetStock`,
          ),
          attempts: asInteger(
            entry.attempts,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].attempts`,
          ),
          nextRunAt: asIsoDate(
            entry.nextRunAt,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].nextRunAt`,
          ),
          status: asNonEmptyString(
            entry.status,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].status`,
          ),
          lastError: asNullableString(
            entry.lastError,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].lastError`,
          ),
          orderId: asNullableString(
            entry.orderId,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].orderId`,
          ),
          createdAt: asIsoDate(
            entry.createdAt,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].createdAt`,
          ),
          updatedAt: asIsoDate(
            entry.updatedAt,
            `Grupo ${ownerId}: stockSyncJobsTouched[${index}].updatedAt`,
          ),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const listingIdsToMove = asUniqueStrings(
      raw.expected.listingIdsToMove,
      `Grupo ${ownerId}: listingIdsToMove`,
    );
    for (const listingId of listingIdsToMove) {
      if (seenListings.has(listingId))
        throw new CliError(
          "INVALID_MANIFEST",
          `Listing ${listingId} aparece em mais de um grupo.`,
        );
      seenListings.add(listingId);
    }
    if (!isRecord(raw.evidence))
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} não possui evidence.`,
      );
    const rawPhotoIds = asUniqueStrings(
      raw.evidence.photoIds,
      `Grupo ${ownerId}: evidence.photoIds`,
      false,
    );
    const canonicalPhotoIds = rawPhotoIds.map((photo) =>
      canonicalManifestPhoto(photo),
    );
    if (canonicalPhotoIds.some((photo) => !photo)) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} contém foto fora das origens canônicas permitidas.`,
      );
    }
    const photoIds = canonicalPhotoIds as string[];
    if (new Set(photoIds).size < 2)
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} possui menos de duas fotos de evidência.`,
      );
    if (
      !Array.isArray(raw.evidence.galleryIdentities) ||
      raw.evidence.galleryIdentities.length === 0
    ) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} deve declarar ao menos um fingerprint completo de galeria.`,
      );
    }
    const galleryIdentities = raw.evidence.galleryIdentities
      .map((entry, index) => {
        if (!isRecord(entry)) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: galleryIdentities[${index}] inválida.`,
          );
        }
        const platform = asNonEmptyString(
          entry.platform,
          `Grupo ${ownerId}: galleryIdentities[${index}].platform`,
        ).toUpperCase();
        const identityKey = asNonEmptyString(
          entry.identityKey,
          `Grupo ${ownerId}: galleryIdentities[${index}].identityKey`,
        );
        if (
          !["MERCADO_LIVRE", "SHOPEE"].includes(platform) ||
          !/^gallery:v1:[a-f0-9]{64}$/.test(identityKey)
        ) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: fingerprint de galeria inválido.`,
          );
        }
        const imageIds = sortedUnique(
          asUniqueStrings(
            entry.imageIds,
            `Grupo ${ownerId}: galleryIdentities[${index}].imageIds`,
            false,
          ).map((imageId) => imageId.toLowerCase()),
        );
        const validImageIds =
          imageIds.length >= 2 &&
          imageIds.every((imageId) =>
            platform === "MERCADO_LIVRE"
              ? /^\d+-ml[a-z]\d+_\d+$/.test(imageId)
              : /^[a-z0-9-]+$/.test(imageId),
          );
        const recomputedKey = `gallery:v1:${sha256(JSON.stringify(imageIds))}`;
        const evidenceImageIds = sortedUnique(
          photoIds.flatMap((photo) => {
            if (platform === "MERCADO_LIVRE" && photo.startsWith("ml:")) {
              return [photo.slice(3).toLowerCase()];
            }
            if (platform === "SHOPEE" && photo.startsWith("shopee:/file/")) {
              return [
                photo
                  .slice("shopee:/file/".length)
                  .replace(/_tn$/i, "")
                  .toLowerCase(),
              ];
            }
            return [];
          }),
        );
        if (
          !validImageIds ||
          identityKey !== recomputedKey ||
          !arraysEqual(imageIds, evidenceImageIds)
        ) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Grupo ${ownerId}: fingerprint não corresponde à galeria completa assinada.`,
          );
        }
        const scopedKey = `${platform}\u0000${identityKey}`;
        if (seenGalleryIdentities.has(scopedKey)) {
          throw new CliError(
            "INVALID_MANIFEST",
            `Fingerprint ${platform}/${identityKey} aparece em mais de um grupo.`,
          );
        }
        seenGalleryIdentities.add(scopedKey);
        return { platform, identityKey, imageIds };
      })
      .sort((left, right) =>
        `${left.platform}\u0000${left.identityKey}`.localeCompare(
          `${right.platform}\u0000${right.identityKey}`,
        ),
      );
    const expected = {
      ownerStockUnchanged: asInteger(
        raw.expected.ownerStockUnchanged,
        `Grupo ${ownerId}: ownerStockUnchanged`,
      ),
      donorStocksNotSummed,
      reservedTotal: asInteger(
        raw.expected.reservedTotal,
        `Grupo ${ownerId}: reservedTotal`,
      ),
      donorBlockingHistoryTotal: asInteger(
        raw.expected.donorBlockingHistoryTotal,
        `Grupo ${ownerId}: donorBlockingHistoryTotal`,
      ),
      donorStockLogsToReparent: asInteger(
        raw.expected.donorStockLogsToReparent,
        `Grupo ${ownerId}: donorStockLogsToReparent`,
      ),
      donorStockLogs,
      stockSyncJobsTouched,
      listingIdsToMove,
    };
    if (expected.donorStockLogsToReparent !== donorStockLogs.length) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId}: contagem de StockLog não corresponde às linhas assinadas.`,
      );
    }
    if (
      expected.reservedTotal !== 0 ||
      expected.donorBlockingHistoryTotal !== 0
    ) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} declara reserva ou histórico impeditivo.`,
      );
    }
    if (sourceCode === null && externalSkus.length !== 1) {
      throw new CliError(
        "INVALID_MANIFEST",
        `Grupo ${ownerId} sem código de origem exige exatamente um SKU externo.`,
      );
    }
    return {
      ...raw,
      ownerId,
      duplicateIds,
      name,
      exactNormalizedTitle: true,
      exactFullGallery: raw.exactFullGallery,
      sourceCode,
      externalSkus,
      expected,
      evidence: {
        ...raw.evidence,
        photoIds: sortedUnique(photoIds),
        galleryIdentities,
      },
    } as MergeManifestGroup;
  });
  return { ...value, version: 1, tenant, tenantId, groups } as MergeManifest;
}

export function parseIdentitySeed(
  value: unknown,
  manifest: MergeManifest,
): IdentitySeed {
  if (!isRecord(value) || value.version !== 1) {
    throw new CliError(
      "INVALID_IDENTITY_SEED",
      "Identity seed deve ser objeto com version=1.",
    );
  }
  const tenant = asNonEmptyString(value.tenant, "identitySeed.tenant");
  const tenantId = asNonEmptyString(value.tenantId, "identitySeed.tenantId");
  if (tenantId !== manifest.tenantId || tenant !== manifest.tenant) {
    throw new CliError(
      "IDENTITY_TENANT_MISMATCH",
      "Identity seed e manifesto apontam para tenants diferentes.",
    );
  }
  if (!Array.isArray(value.identities)) {
    throw new CliError(
      "INVALID_IDENTITY_SEED",
      "identitySeed.identities deve ser uma lista.",
    );
  }
  const owners = new Set(manifest.groups.map((group) => group.ownerId));
  const reviewedGalleryOwners = new Map<string, string>(
    manifest.groups.flatMap((group) =>
      group.evidence.galleryIdentities.map(
        (identity) =>
          [
            `${identity.platform}\u0000${identity.identityKey}`,
            group.ownerId,
          ] as const,
      ),
    ),
  );
  const seen = new Set<string>();
  const identities = value.identities.map((raw, index) => {
    if (!isRecord(raw))
      throw new CliError(
        "INVALID_IDENTITY_SEED",
        `identities[${index}] inválida.`,
      );
    const platform = asNonEmptyString(
      raw.platform,
      `identities[${index}].platform`,
    ).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(platform)) {
      throw new CliError(
        "INVALID_IDENTITY_SEED",
        `identities[${index}].platform inválida.`,
      );
    }
    const identityKey = asNonEmptyString(
      raw.identityKey,
      `identities[${index}].identityKey`,
    );
    if (identityKey.length > 500 || /[\u0000-\u001f]/.test(identityKey)) {
      throw new CliError(
        "INVALID_IDENTITY_SEED",
        `identities[${index}].identityKey inválida.`,
      );
    }
    const status = asNonEmptyString(
      raw.status,
      `identities[${index}].status`,
    ).toUpperCase() as IdentityStatus;
    if (!IDENTITY_STATUSES.has(status)) {
      throw new CliError(
        "INVALID_IDENTITY_SEED",
        `identities[${index}].status inválido.`,
      );
    }
    const productId =
      raw.productId === null
        ? null
        : asNonEmptyString(raw.productId, `identities[${index}].productId`);
    if (
      status === "AMBIGUOUS"
        ? productId !== null
        : !productId || !owners.has(productId)
    ) {
      throw new CliError(
        "INVALID_IDENTITY_TARGET",
        `Identidade ${platform}/${identityKey} não aponta para owner canônico compatível com seu status.`,
      );
    }
    const primaryKey = `${platform}\u0000${identityKey}`;
    const listingAlias = /^listing:[^:\s]+:[^:\s]+$/.test(identityKey);
    const galleryAlias = /^gallery:v1:[a-f0-9]{64}$/.test(identityKey);
    if (!listingAlias && !galleryAlias) {
      throw new CliError(
        "INVALID_IDENTITY_KEY",
        `Identidade ${platform}/${identityKey} não é listing:<conta>:<externo> nem gallery:v1:<sha256>.`,
      );
    }
    if (listingAlias && status !== "CONFIRMED") {
      throw new CliError(
        "INVALID_LISTING_ALIAS_STATUS",
        `Alias exato de listing ${identityKey} deve ser CONFIRMED.`,
      );
    }
    if (galleryAlias && status === "CONFIRMED") {
      const reviewedOwner = reviewedGalleryOwners.get(primaryKey);
      if (!reviewedOwner || productId !== reviewedOwner) {
        throw new CliError(
          "UNREVIEWED_CONFIRMED_GALLERY",
          `Galeria confirmada ${platform}/${identityKey} não consta na whitelist assinada do owner.`,
        );
      }
    }
    const normalizedSellerSkus = asUniqueStrings(
      raw.sellerSkus,
      `identities[${index}].sellerSkus`,
    ).map((sku) => sku.toLowerCase());
    if (new Set(normalizedSellerSkus).size !== normalizedSellerSkus.length) {
      throw new CliError(
        "INVALID_IDENTITY_SEED",
        `identities[${index}].sellerSkus contém duplicatas após normalização.`,
      );
    }
    const sellerSkus = sortedUnique(normalizedSellerSkus);
    let evidence: IdentitySeedRow["evidence"];
    if (raw.evidence !== undefined) {
      if (!isRecord(raw.evidence)) {
        throw new CliError(
          "INVALID_IDENTITY_SEED",
          `identities[${index}].evidence deve ser objeto.`,
        );
      }
      evidence = {
        observations: asInteger(
          raw.evidence.observations,
          `identities[${index}].evidence.observations`,
          1,
        ),
        originalProductIds: asUniqueStrings(
          raw.evidence.originalProductIds,
          `identities[${index}].evidence.originalProductIds`,
          false,
        ),
        sources: asUniqueStrings(
          raw.evidence.sources,
          `identities[${index}].evidence.sources`,
          false,
        ),
      };
    }
    if (seen.has(primaryKey))
      throw new CliError(
        "INVALID_IDENTITY_SEED",
        `Identidade repetida: ${platform}/${identityKey}.`,
      );
    seen.add(primaryKey);
    return { platform, identityKey, productId, status, sellerSkus, evidence };
  });
  return { ...value, version: 1, tenant, tenantId, identities } as IdentitySeed;
}

export function assertProductionDatabaseHost(
  databaseUrl: string | undefined,
  allowAnyHost: boolean,
  expectedProjectRef: string | undefined = process.env
    .CATALOG_MERGE_DATABASE_PROJECT_REF,
): string {
  if (!databaseUrl)
    throw new CliError("DATABASE_URL_MISSING", "DATABASE_URL não configurada.");
  let hostname: string;
  let username: string;
  try {
    const parsed = new URL(databaseUrl);
    hostname = parsed.hostname.toLowerCase();
    username = decodeURIComponent(parsed.username).toLowerCase();
  } catch {
    throw new CliError("DATABASE_URL_INVALID", "DATABASE_URL inválida.");
  }
  if (
    !allowAnyHost &&
    !/^aws-\d+-sa-east-1\.pooler\.supabase\.com$/.test(hostname)
  ) {
    throw new CliError(
      "DATABASE_HOST_REFUSED",
      `Host ${hostname} não foi reconhecido como produção sa-east-1; use --allow-any-host somente em ambiente controlado.`,
    );
  }
  if (!allowAnyHost) {
    const projectRef = username.match(/^postgres\.([a-z0-9]{10,40})$/)?.[1];
    if (!expectedProjectRef || !/^[a-z0-9]{10,40}$/i.test(expectedProjectRef)) {
      throw new CliError(
        "DATABASE_PROJECT_REF_MISSING",
        "CATALOG_MERGE_DATABASE_PROJECT_REF não configurado para atestar o projeto de produção.",
      );
    }
    if (!projectRef || projectRef !== expectedProjectRef.toLowerCase()) {
      throw new CliError(
        "DATABASE_PROJECT_REF_REFUSED",
        "O project-ref do DATABASE_URL não corresponde ao projeto de produção atestado.",
      );
    }
  }
  return hostname;
}

export function assertWorkersDrainedForApply(
  apply: boolean,
  environment: Record<string, string | undefined> = process.env,
): void {
  if (apply && environment.CATALOG_MERGE_WORKERS_DRAINED !== "1") {
    throw new CliError(
      "WORKERS_NOT_DRAINED",
      "Apply exige API e sync workers parados/drenados e CATALOG_MERGE_WORKERS_DRAINED=1 nesta invocação.",
    );
  }
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
    2,
  );
}

function createExclusiveJson(
  outputDir: string,
  prefix: string,
  value: unknown,
): { file: string; sha256: string } {
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = attempt === 0 ? "" : `-${randomUUID().slice(0, 8)}`;
    const file = path.join(outputDir, `${prefix}-${timestamp}${suffix}.json`);
    const content = `${jsonStringify(value)}\n`;
    try {
      const descriptor = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, content, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      const digest = sha256(content);
      fs.writeFileSync(
        `${file}.sha256`,
        `${digest}  ${path.basename(file)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return { file, sha256: digest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new CliError(
    "OUTPUT_COLLISION",
    `Não foi possível reservar arquivo exclusivo em ${outputDir}.`,
  );
}

function issue(
  code: string,
  message: string,
  details: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { code, message, ...details };
}

function productGallery(product: LockedProduct): string[] {
  return sortedUnique(
    [product.imageUrl, ...(product.imageUrls ?? [])]
      .map(canonicalManifestPhoto)
      .filter((photo): photo is string => Boolean(photo)),
  );
}

function galleryNamespace(photo: string): string {
  const separator = photo.indexOf(":");
  return separator > 0 ? photo.slice(0, separator + 1) : "opaque:";
}

function galleriesStronglyMatch(left: string[], right: string[]): boolean {
  const namespaces = new Set([...left, ...right].map(galleryNamespace));
  return [...namespaces].some((namespace) => {
    const l = left.filter((photo) => galleryNamespace(photo) === namespace);
    const r = right.filter((photo) => galleryNamespace(photo) === namespace);
    const rightSet = new Set(r);
    const common = l.filter((photo) => rightSet.has(photo)).length;
    return common >= 2 && common / Math.max(l.length, r.length) >= 0.9;
  });
}

function galleryGraphConnected(galleries: string[][]): boolean {
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const current = queue.shift()!;
    for (let index = 0; index < galleries.length; index++) {
      if (
        !seen.has(index) &&
        galleriesStronglyMatch(galleries[current], galleries[index])
      ) {
        seen.add(index);
        queue.push(index);
      }
    }
  }
  return seen.size === galleries.length;
}

/**
 * A merge is durable only when every live listing and the reviewed complete
 * gallery already point to the selected owner in the signed identity seed.
 */
export function validateGroupIdentityCoverage(
  group: MergeManifestGroup,
  seed: IdentitySeed,
  listings: LiveListing[],
  tenantId: string,
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const members = new Set([group.ownerId, ...group.duplicateIds]);
  const groupListings = listings.filter((listing) =>
    members.has(listing.productId),
  );
  const seedByKey = new Map(
    seed.identities.map((row) => [
      `${row.platform}\u0000${row.identityKey}`,
      row,
    ]),
  );

  for (const listing of groupListings) {
    if (listing.accountDataOwnerId !== tenantId) {
      errors.push(
        issue(
          "LISTING_ACCOUNT_TENANT_MISMATCH",
          `Listing ${listing.id} pertence a conta de outro tenant.`,
          {
            ownerId: group.ownerId,
            productId: listing.productId,
            expected: tenantId,
            actual: listing.accountDataOwnerId,
          },
        ),
      );
    }
    const identityKey = `listing:${listing.marketplaceAccountId}:${listing.externalListingId}`;
    const alias = seedByKey.get(`${listing.platform}\u0000${identityKey}`);
    const externalSku = listing.externalSku?.trim().toLowerCase() ?? "";
    if (
      !alias ||
      alias.status !== "CONFIRMED" ||
      alias.productId !== group.ownerId ||
      (externalSku && !alias.sellerSkus.includes(externalSku))
    ) {
      errors.push(
        issue(
          "LIVE_LISTING_IDENTITY_NOT_CONFIRMED",
          `Listing ${listing.id} não possui alias exato e confirmado para o owner.`,
          {
            ownerId: group.ownerId,
            productId: listing.productId,
            expected: {
              platform: listing.platform,
              identityKey,
              productId: group.ownerId,
              sellerSku: externalSku || null,
            },
            actual: alias ?? null,
          },
        ),
      );
    }
  }

  const confirmedGalleries = group.evidence.galleryIdentities
    .map(({ platform, identityKey }) =>
      seedByKey.get(`${platform}\u0000${identityKey}`),
    )
    .filter((row): row is IdentitySeedRow =>
      Boolean(
        row && row.status === "CONFIRMED" && row.productId === group.ownerId,
      ),
    );
  const requiredSkusByPlatform = new Map<string, string[]>();
  for (const { platform } of group.evidence.galleryIdentities) {
    requiredSkusByPlatform.set(
      platform,
      sortedUnique(
        groupListings
          .filter((listing) => listing.platform === platform)
          .map((listing) => listing.externalSku?.trim().toLowerCase() ?? "")
          .filter(Boolean),
      ),
    );
  }
  const everyGalleryHasAllSkus =
    confirmedGalleries.length === group.evidence.galleryIdentities.length &&
    confirmedGalleries.every((row) =>
      arraysEqual(
        sortedUnique(row.sellerSkus),
        requiredSkusByPlatform.get(row.platform) ?? [],
      ),
    );
  if (!everyGalleryHasAllSkus) {
    errors.push(
      issue(
        "REVIEWED_GALLERY_IDENTITY_NOT_CONFIRMED",
        `Grupo ${group.ownerId} não possui identidade de galeria confirmada com todos os SKUs revisados.`,
        {
          ownerId: group.ownerId,
          expected: {
            galleryIdentities: group.evidence.galleryIdentities,
            productId: group.ownerId,
            sellerSkusByPlatform: Object.fromEntries(requiredSkusByPlatform),
          },
          actual: confirmedGalleries,
        },
      ),
    );
  }
  return errors;
}

/**
 * Algumas fichas legadas do Tijuco preservam a galeria original do VAAPT no
 * Product, enquanto seus anúncios vivos usam a galeria do Mercado Livre que
 * provou a duplicidade. Nesse caso não há como reconstruir a prova só pelas
 * imagens do Product sem consultar o marketplace durante a manutenção.
 *
 * O fallback aceita apenas a evidência revisada e assinada que cobre
 * exatamente todos os membros do grupo. Cada anúncio citado na evidência
 * precisa continuar vivo no grupo e ter seu alias exato, account-scoped,
 * confirmado no mesmo seed. Grupos sem código de origem nunca usam o fallback.
 */
export function hasReviewedGalleryFallback(
  group: MergeManifestGroup,
  seed: IdentitySeed,
  listings: LiveListing[],
): boolean {
  if (!group.sourceCode || group.exactFullGallery) return false;
  const members = sortedUnique([group.ownerId, ...group.duplicateIds]);
  const listingAliases = new Set(
    seed.identities
      .filter(
        (row) =>
          row.status === "CONFIRMED" &&
          row.productId === group.ownerId &&
          row.identityKey.startsWith("listing:"),
      )
      .map((row) => `${row.platform}\u0000${row.identityKey}`),
  );
  const groupListings = listings.filter((listing) =>
    members.includes(listing.productId),
  );

  return seed.identities.some((row) => {
    if (
      row.status !== "CONFIRMED" ||
      row.productId !== group.ownerId ||
      !row.identityKey.startsWith("gallery:v1:") ||
      !row.evidence ||
      row.evidence.observations < members.length ||
      !arraysEqual(sortedUnique(row.evidence.originalProductIds), members)
    ) {
      return false;
    }
    const rawListingSources = row.evidence.sources.filter((source) =>
      source.startsWith("listing:"),
    );
    const sourceListings = rawListingSources.map((source) => {
      const match = source.match(
        /^listing:([A-Z][A-Z0-9_]{1,63}):([^:\s]+):([^:\s]+):([^:\s]+)$/,
      );
      return match
        ? {
            platform: match[1],
            accountId: match[2],
            externalListingId: match[3],
            originalProductId: match[4],
          }
        : null;
    });
    if (
      !sourceListings.length ||
      row.evidence.observations < sourceListings.length ||
      sourceListings.some(
        (source) =>
          !source ||
          source.platform !== row.platform ||
          !members.includes(source.originalProductId),
      )
    ) {
      return false;
    }
    if (
      !arraysEqual(
        sortedUnique(
          sourceListings.flatMap((source) =>
            source ? [source.originalProductId] : [],
          ),
        ),
        members,
      )
    ) {
      return false;
    }
    return sourceListings.every((source) => {
      if (!source) return false;
      const live = groupListings.find(
        (listing) =>
          listing.platform === source.platform &&
          listing.marketplaceAccountId === source.accountId &&
          listing.externalListingId === source.externalListingId &&
          listing.productId === source.originalProductId,
      );
      if (!live) return false;
      return listingAliases.has(
        `${live.platform}\u0000listing:${live.marketplaceAccountId}:${live.externalListingId}`,
      );
    });
  });
}

async function createPlanTempTables(
  tx: Prisma.TransactionClient,
  manifest: MergeManifest,
  seed: IdentitySeed,
): Promise<void> {
  await tx.$executeRaw`
    CREATE TEMP TABLE _catalog_merge_map (
      owner_id TEXT NOT NULL,
      duplicate_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      expected_owner_stock INTEGER NOT NULL,
      expected_donor_stock INTEGER NOT NULL
    ) ON COMMIT DROP
  `;
  await tx.$executeRaw`
    CREATE TEMP TABLE _catalog_merge_expected_listing (
      listing_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL
    ) ON COMMIT DROP
  `;
  await tx.$executeRaw`
    CREATE TEMP TABLE _catalog_merge_seed (
      platform TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      product_id TEXT,
      status TEXT NOT NULL,
      seller_skus JSONB NOT NULL,
      PRIMARY KEY (platform, identity_key)
    ) ON COMMIT DROP
  `;
  const mapRows = manifest.groups.flatMap((group) =>
    group.duplicateIds.map((duplicateId) => ({
      owner_id: group.ownerId,
      duplicate_id: duplicateId,
      group_name: group.name,
      expected_owner_stock: group.expected.ownerStockUnchanged,
      expected_donor_stock: group.expected.donorStocksNotSummed.find(
        (row) => row.productId === duplicateId,
      )!.stock,
    })),
  );
  await tx.$executeRaw`
    INSERT INTO _catalog_merge_map (owner_id, duplicate_id, group_name, expected_owner_stock, expected_donor_stock)
    SELECT x.owner_id, x.duplicate_id, x.group_name, x.expected_owner_stock, x.expected_donor_stock
      FROM jsonb_to_recordset(${JSON.stringify(mapRows)}::jsonb)
        AS x(owner_id TEXT, duplicate_id TEXT, group_name TEXT, expected_owner_stock INTEGER, expected_donor_stock INTEGER)
  `;
  const listingRows = manifest.groups.flatMap((group) =>
    group.expected.listingIdsToMove.map((listingId) => ({
      listing_id: listingId,
      owner_id: group.ownerId,
    })),
  );
  if (listingRows.length) {
    await tx.$executeRaw`
      INSERT INTO _catalog_merge_expected_listing (listing_id, owner_id)
      SELECT x.listing_id, x.owner_id
        FROM jsonb_to_recordset(${JSON.stringify(listingRows)}::jsonb)
          AS x(listing_id TEXT, owner_id TEXT)
    `;
  }
  if (seed.identities.length) {
    const insertedSeedRows = await tx.$executeRaw`
      INSERT INTO _catalog_merge_seed (platform, identity_key, product_id, status, seller_skus)
      SELECT x.platform, x.identity_key, x.product_id, x.status, x.seller_skus
        FROM jsonb_to_recordset(${JSON.stringify(
          seed.identities.map((row) => ({
            platform: row.platform,
            identity_key: row.identityKey,
            product_id: row.productId,
            status: row.status,
            seller_skus: row.sellerSkus,
          })),
        )}::jsonb)
          AS x(platform TEXT, identity_key TEXT, product_id TEXT, status TEXT, seller_skus JSONB)
    `;
    if (Number(insertedSeedRows) !== seed.identities.length) {
      throw new CliError(
        "IDENTITY_TEMP_PLAN_COUNT_MISMATCH",
        `Plano temporário recebeu ${insertedSeedRows}/${seed.identities.length} identidades.`,
      );
    }
  }
}

async function lockAndReadProducts(
  tx: Prisma.TransactionClient,
  ids: string[],
  lock: boolean,
): Promise<LockedProduct[]> {
  return lock
    ? tx.$queryRaw<LockedProduct[]>`
        SELECT id, "userId", name, stock, "reservedStock", "autoCreatedFromSale", "scrapId",
               attributes, "imageUrl", "imageUrls"
          FROM "Product"
         WHERE id = ANY(${ids}::text[])
         ORDER BY id
         FOR UPDATE
      `
    : tx.$queryRaw<LockedProduct[]>`
        SELECT id, "userId", name, stock, "reservedStock", "autoCreatedFromSale", "scrapId",
               attributes, "imageUrl", "imageUrls"
          FROM "Product"
         WHERE id = ANY(${ids}::text[])
         ORDER BY id
      `;
}

async function collectValidation(
  tx: Prisma.TransactionClient,
  manifest: MergeManifest,
  seed: IdentitySeed,
  apply: boolean,
): Promise<{
  errors: ValidationIssue[];
  products: LockedProduct[];
  listings: LiveListing[];
  stockLogs: StockLogGuard[];
  stockSyncJobs: StockSyncJobGuard[];
  identityTablePresent: boolean;
}> {
  const errors: ValidationIssue[] = [];
  const allIds = sortedUnique(
    manifest.groups.flatMap((group) => [group.ownerId, ...group.duplicateIds]),
  );
  const donorIds = sortedUnique(
    manifest.groups.flatMap((group) => group.duplicateIds),
  );
  const products = await lockAndReadProducts(tx, allIds, apply);
  const productById = new Map(products.map((product) => [product.id, product]));
  const listings = apply
    ? await tx.$queryRaw<LiveListing[]>`
        SELECT pl.id, pl."productId", pl."marketplaceAccountId", pl."externalListingId",
               pl."externalSku", ma.platform::text AS platform,
               ma."userId" AS "accountDataOwnerId"
          FROM "ProductListing" pl
          JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
         WHERE pl."productId" = ANY(${allIds}::text[])
         ORDER BY pl.id
         FOR UPDATE OF pl
      `
    : await tx.$queryRaw<LiveListing[]>`
        SELECT pl.id, pl."productId", pl."marketplaceAccountId", pl."externalListingId",
               pl."externalSku", ma.platform::text AS platform,
               ma."userId" AS "accountDataOwnerId"
          FROM "ProductListing" pl
          JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
         WHERE pl."productId" = ANY(${allIds}::text[])
         ORDER BY pl.id
      `;
  if (apply) {
    // Production writers acquire Product (when changing stock), then the
    // per-listing advisory, then write StockSyncJob. Follow the same order.
    // Include pre-existing job listing IDs so malformed legacy rows cannot
    // invert it. An in-flight writer finishes first and its committed row is
    // then included in the signed-evidence check below.
    const preexistingJobListingIds = await tx.$queryRaw<
      Array<{ listingId: string }>
    >`
      SELECT DISTINCT j."listingId"
        FROM "StockSyncJob" j
       WHERE j."productId" = ANY(${donorIds}::text[])
          OR (j.status = 'PENDING' AND j."listingId" = ANY(${listings.map((row) => row.id)}::text[]))
       ORDER BY j."listingId"
    `;
    const stockLockListingIds = sortedUnique([
      ...listings.map((listing) => listing.id),
      ...preexistingJobListingIds.map((row) => row.listingId),
    ]);
    if (stockLockListingIds.length) {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext('stock_sync_job:' || listing_id))
          FROM unnest(${stockLockListingIds}::text[]) AS locked(listing_id)
         ORDER BY listing_id
      `;
    }
    // StockSyncJob has no Product FK. Once every legitimate writer is fenced
    // by its advisory lock, SHARE closes insert/update phantoms until commit.
    // BulkListingJob uses the separate global catalog merge advisory gate.
    await tx.$executeRaw`LOCK TABLE "StockSyncJob" IN SHARE MODE`;
  }
  const stockLogs = apply
    ? await tx.$queryRaw<StockLogGuard[]>`
        SELECT id, "productId", change, reason, "previousStock", "newStock", "createdAt"
          FROM "StockLog"
         WHERE "productId" = ANY(${donorIds}::text[])
         ORDER BY id
         FOR UPDATE
      `
    : await tx.$queryRaw<StockLogGuard[]>`
        SELECT id, "productId", change, reason, "previousStock", "newStock", "createdAt"
          FROM "StockLog"
         WHERE "productId" = ANY(${donorIds}::text[])
          ORDER BY id
      `;
  const stockSyncJobs = apply
    ? await tx.$queryRaw<StockSyncJobGuard[]>`
        SELECT j.id, j."productId", j."listingId", j.platform::text AS platform,
               j."targetStock", j.attempts, j."nextRunAt", j.status,
               j."lastError", j."orderId", j."createdAt", j."updatedAt",
               pl."productId" AS "listingProductId",
               ma.platform::text AS "listingPlatform",
               ma."userId" AS "accountDataOwnerId"
          FROM "StockSyncJob" j
          LEFT JOIN "ProductListing" pl ON pl.id = j."listingId"
          LEFT JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
         WHERE j."productId" = ANY(${donorIds}::text[])
            OR (j.status = 'PENDING' AND EXISTS (
              SELECT 1 FROM "ProductListing" touched
               WHERE touched.id = j."listingId"
                 AND touched."productId" = ANY(${allIds}::text[])
            ))
         ORDER BY j.id
         FOR UPDATE OF j
      `
    : await tx.$queryRaw<StockSyncJobGuard[]>`
        SELECT j.id, j."productId", j."listingId", j.platform::text AS platform,
               j."targetStock", j.attempts, j."nextRunAt", j.status,
               j."lastError", j."orderId", j."createdAt", j."updatedAt",
               pl."productId" AS "listingProductId",
               ma.platform::text AS "listingPlatform",
               ma."userId" AS "accountDataOwnerId"
          FROM "StockSyncJob" j
          LEFT JOIN "ProductListing" pl ON pl.id = j."listingId"
          LEFT JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
         WHERE j."productId" = ANY(${donorIds}::text[])
            OR (j.status = 'PENDING' AND EXISTS (
              SELECT 1 FROM "ProductListing" touched
               WHERE touched.id = j."listingId"
                 AND touched."productId" = ANY(${allIds}::text[])
            ))
         ORDER BY j.id
      `;
  const historyCounts = await tx.$queryRaw<
    Array<{ tableName: string; productId: string; count: number }>
  >`
    SELECT 'OrderItem' AS "tableName", "productId", COUNT(*)::int AS count FROM "OrderItem"
      WHERE "productId" = ANY(${donorIds}::text[]) GROUP BY "productId"
    UNION ALL
    SELECT 'ReceivableItem', "productId", COUNT(*)::int FROM "ReceivableItem"
      WHERE "productId" = ANY(${donorIds}::text[]) GROUP BY "productId"
    UNION ALL
    SELECT 'BudgetItem', "productId", COUNT(*)::int FROM "BudgetItem"
      WHERE "productId" = ANY(${donorIds}::text[]) GROUP BY "productId"
    UNION ALL
    SELECT 'NfeItem', "productId", COUNT(*)::int FROM "NfeItem"
      WHERE "productId" = ANY(${donorIds}::text[]) GROUP BY "productId"
    ORDER BY "productId", "tableName"
  `;
  const activeBulkJobs = await tx.$queryRaw<
    Array<{ id: string; status: string }>
  >`
    SELECT id, status::text AS status FROM "BulkListingJob"
     WHERE status IN ('QUEUED', 'RUNNING')
     ORDER BY id
  `;
  if (activeBulkJobs.length) {
    errors.push(
      issue(
        "ACTIVE_BULK_JOB",
        "Há jobs de publicação em lote ativos; a fusão exige fila global drenada.",
        {
          actual: activeBulkJobs,
        },
      ),
    );
  }
  const identityPresence = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('"ProductIngestionIdentity"') IS NOT NULL AS present
  `;
  const identityTablePresent = identityPresence[0]?.present === true;
  if (!identityTablePresent) {
    errors.push(
      issue(
        "IDENTITY_TABLE_MISSING",
        "Tabela ProductIngestionIdentity ausente.",
      ),
    );
  }

  for (const id of allIds) {
    const product = productById.get(id);
    if (!product) {
      errors.push(
        issue("PRODUCT_MISSING", `Produto ${id} não existe.`, {
          productId: id,
        }),
      );
    } else if (product.userId !== manifest.tenantId) {
      errors.push(
        issue("PRODUCT_TENANT_MISMATCH", `Produto ${id} está fora do tenant.`, {
          productId: id,
          expected: manifest.tenantId,
          actual: product.userId,
        }),
      );
    }
  }

  for (const group of manifest.groups) {
    const members = [group.ownerId, ...group.duplicateIds]
      .map((id) => productById.get(id))
      .filter((product): product is LockedProduct => Boolean(product));
    if (members.length !== group.duplicateIds.length + 1) continue;
    const expectedName = normalizeManifestName(group.name);
    for (const product of members) {
      const actualName = normalizeManifestName(product.name);
      if (actualName !== expectedName) {
        errors.push(
          issue(
            "TITLE_CHANGED",
            `Título normalizado de ${product.id} divergiu do manifesto.`,
            {
              ownerId: group.ownerId,
              productId: product.id,
              expected: expectedName,
              actual: actualName,
            },
          ),
        );
      }
      if (product.reservedStock !== 0) {
        errors.push(
          issue(
            "RESERVED_STOCK",
            `Produto ${product.id} possui estoque reservado.`,
            {
              ownerId: group.ownerId,
              productId: product.id,
              expected: 0,
              actual: product.reservedStock,
            },
          ),
        );
      }
      if (product.autoCreatedFromSale) {
        errors.push(
          issue(
            "AUTO_CREATED_FROM_SALE",
            `Produto ${product.id} foi criado por venda avulsa.`,
            {
              ownerId: group.ownerId,
              productId: product.id,
            },
          ),
        );
      }
    }
    const owner = productById.get(group.ownerId)!;
    if (owner.stock !== group.expected.ownerStockUnchanged) {
      errors.push(
        issue(
          "OWNER_STOCK_CHANGED",
          `Estoque do owner ${owner.id} mudou desde o manifesto.`,
          {
            ownerId: owner.id,
            productId: owner.id,
            expected: group.expected.ownerStockUnchanged,
            actual: owner.stock,
          },
        ),
      );
    }
    for (const expectedDonor of group.expected.donorStocksNotSummed) {
      const donor = productById.get(expectedDonor.productId)!;
      if (donor.stock !== expectedDonor.stock) {
        errors.push(
          issue(
            "DONOR_STOCK_CHANGED",
            `Estoque do donor ${donor.id} mudou desde o manifesto.`,
            {
              ownerId: group.ownerId,
              productId: donor.id,
              expected: expectedDonor.stock,
              actual: donor.stock,
            },
          ),
        );
      }
    }
    const scrapIds = new Set(members.map((product) => product.scrapId));
    if (scrapIds.size !== 1) {
      errors.push(
        issue(
          "SCRAP_MISMATCH",
          `Grupo ${group.ownerId} possui sucatas de origem divergentes.`,
          {
            ownerId: group.ownerId,
            actual: [...scrapIds],
          },
        ),
      );
    }
    const sourceCodes = sortedUnique(
      members
        .map((product) => liveSourceCode(product.attributes))
        .filter(Boolean),
    );
    const expectedCodes = group.sourceCode ? [group.sourceCode] : [];
    if (!arraysEqual(sourceCodes, expectedCodes)) {
      errors.push(
        issue(
          "SOURCE_CODE_CHANGED",
          `Códigos de origem do grupo ${group.ownerId} divergiram do manifesto.`,
          {
            ownerId: group.ownerId,
            expected: expectedCodes,
            actual: sourceCodes,
          },
        ),
      );
    }

    const groupListings = listings.filter((listing) =>
      [group.ownerId, ...group.duplicateIds].includes(listing.productId),
    );
    errors.push(
      ...validateGroupIdentityCoverage(
        group,
        seed,
        groupListings,
        manifest.tenantId,
      ),
    );
    const donorListingIds = sortedUnique(
      groupListings
        .filter((listing) => group.duplicateIds.includes(listing.productId))
        .map((listing) => listing.id),
    );
    const expectedListingIds = sortedUnique(group.expected.listingIdsToMove);
    if (!arraysEqual(donorListingIds, expectedListingIds)) {
      errors.push(
        issue(
          "DONOR_LISTINGS_CHANGED",
          `Listings dos donors do grupo ${group.ownerId} mudaram.`,
          {
            ownerId: group.ownerId,
            expected: expectedListingIds,
            actual: donorListingIds,
          },
        ),
      );
    }
    if (group.sourceCode === null) {
      const aliases = sortedUnique(
        groupListings.map(
          (listing) => listing.externalSku?.trim().toUpperCase() ?? "",
        ),
      );
      if (
        groupListings.length < 2 ||
        aliases.includes("") ||
        !arraysEqual(aliases, group.externalSkus)
      ) {
        errors.push(
          issue(
            "EXTERNAL_SKU_IDENTITY_CHANGED",
            `Grupo sem código ${group.ownerId} perdeu o SKU externo comum.`,
            {
              ownerId: group.ownerId,
              expected: group.externalSkus,
              actual: aliases,
            },
          ),
        );
      }
    }

    const galleries = members.map(productGallery);
    const reviewedGalleryFallback = hasReviewedGalleryFallback(
      group,
      seed,
      listings,
    );
    if (!reviewedGalleryFallback) {
      const evidence = new Set(group.evidence.photoIds);
      galleries.forEach((gallery, index) => {
        const evidenceIntersection = gallery.filter((photo) =>
          evidence.has(photo),
        ).length;
        if (gallery.length < 2 || evidenceIntersection < 2) {
          errors.push(
            issue(
              "LIVE_GALLERY_MISSING",
              `Galeria live de ${members[index].id} não confirma a evidência.`,
              {
                ownerId: group.ownerId,
                productId: members[index].id,
                expected: group.evidence.photoIds,
                actual: gallery,
              },
            ),
          );
        }
      });
      if (group.exactFullGallery) {
        if (
          galleries[0].length < 2 ||
          !galleries.every((gallery) => arraysEqual(gallery, galleries[0]))
        ) {
          errors.push(
            issue(
              "FULL_GALLERY_CHANGED",
              `Galerias do grupo ${group.ownerId} deixaram de ser idênticas.`,
              {
                ownerId: group.ownerId,
                actual: galleries,
              },
            ),
          );
        }
      } else if (!galleryGraphConnected(galleries)) {
        errors.push(
          issue(
            "GALLERY_IDENTITY_CHANGED",
            `Galerias live do grupo ${group.ownerId} não formam identidade forte conectada.`,
            {
              ownerId: group.ownerId,
              actual: galleries,
            },
          ),
        );
      }
    }

    const groupLogs = stockLogs.filter((log) =>
      group.duplicateIds.includes(log.productId),
    );
    if (groupLogs.length !== group.expected.donorStockLogsToReparent) {
      errors.push(
        issue(
          "DONOR_STOCK_LOGS_CHANGED",
          `Quantidade de StockLog dos donors do grupo ${group.ownerId} mudou.`,
          {
            ownerId: group.ownerId,
            expected: group.expected.donorStockLogsToReparent,
            actual: groupLogs.length,
          },
        ),
      );
    }
    const liveLogEvidence: ManifestStockLog[] = groupLogs
      .map((log) => ({
        id: log.id,
        productId: log.productId,
        change: log.change,
        reason: log.reason,
        previousStock: log.previousStock,
        newStock: log.newStock,
        createdAt: new Date(log.createdAt).toISOString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (
      liveLogEvidence.length !== group.expected.donorStockLogs.length ||
      liveLogEvidence.some(
        (row, index) =>
          stockLogEvidenceKey(row) !==
          stockLogEvidenceKey(group.expected.donorStockLogs[index]),
      )
    ) {
      errors.push(
        issue(
          "DONOR_STOCK_LOG_EVIDENCE_CHANGED",
          `Conteúdo dos StockLogs dos donors do grupo ${group.ownerId} divergiu das linhas assinadas.`,
          {
            ownerId: group.ownerId,
            expected: group.expected.donorStockLogs,
            actual: liveLogEvidence,
          },
        ),
      );
    }
    const saleLike = groupLogs.filter((log) =>
      isSaleLikeStockLogReason(log.reason),
    );
    if (saleLike.length) {
      errors.push(
        issue(
          "SALE_LIKE_STOCK_LOG",
          `Donor do grupo ${group.ownerId} contém StockLog de venda/estorno/cancelamento/pedido/marketplace.`,
          {
            ownerId: group.ownerId,
            actual: saleLike,
          },
        ),
      );
    }
    const groupMemberIds = [group.ownerId, ...group.duplicateIds];
    const groupJobs = stockSyncJobs.filter(
      (job) =>
        group.duplicateIds.includes(job.productId) ||
        Boolean(
          job.status === "PENDING" &&
          job.listingProductId &&
          groupMemberIds.includes(job.listingProductId),
        ),
    );
    const liveJobEvidence: ManifestStockSyncJob[] = groupJobs
      .map((job) => ({
        id: job.id,
        productId: job.productId,
        listingId: job.listingId,
        platform: job.platform,
        targetStock: job.targetStock,
        attempts: job.attempts,
        nextRunAt: new Date(job.nextRunAt).toISOString(),
        status: job.status,
        lastError: job.lastError,
        orderId: job.orderId,
        createdAt: new Date(job.createdAt).toISOString(),
        updatedAt: new Date(job.updatedAt).toISOString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (
      liveJobEvidence.length !== group.expected.stockSyncJobsTouched.length ||
      liveJobEvidence.some(
        (row, index) =>
          stockSyncJobEvidenceKey(row) !==
          stockSyncJobEvidenceKey(group.expected.stockSyncJobsTouched[index]),
      )
    ) {
      errors.push(
        issue(
          "DONOR_STOCK_SYNC_JOB_EVIDENCE_CHANGED",
          `StockSyncJobs dos donors do grupo ${group.ownerId} divergiram das linhas assinadas.`,
          {
            ownerId: group.ownerId,
            expected: group.expected.stockSyncJobsTouched,
            actual: liveJobEvidence,
          },
        ),
      );
    }
    const inconsistentJobs = groupJobs.filter(
      (job) =>
        !job.listingProductId ||
        job.listingProductId !== job.productId ||
        job.listingPlatform !== job.platform ||
        job.accountDataOwnerId !== manifest.tenantId,
    );
    if (inconsistentJobs.length) {
      errors.push(
        issue(
          "DONOR_STOCK_SYNC_JOB_INCONSISTENT",
          `StockSyncJob de donor no grupo ${group.ownerId} aponta para listing, plataforma ou tenant divergente.`,
          { ownerId: group.ownerId, actual: inconsistentJobs },
        ),
      );
    }
  }

  if (historyCounts.length) {
    for (const row of historyCounts) {
      errors.push(
        issue(
          "DONOR_BLOCKING_HISTORY",
          `${row.tableName} ainda referencia donor ${row.productId}.`,
          {
            productId: row.productId,
            actual: row.count,
          },
        ),
      );
    }
  }

  if (identityTablePresent) {
    const donorIdentities = apply
      ? await tx.$queryRaw<ExistingIdentity[]>`
          SELECT "userId", platform, "identityKey", "productId", status
            FROM "ProductIngestionIdentity"
           WHERE "productId" = ANY(${donorIds}::text[])
           ORDER BY "userId", platform, "identityKey"
           FOR UPDATE
        `
      : await tx.$queryRaw<ExistingIdentity[]>`
          SELECT "userId", platform, "identityKey", "productId", status
            FROM "ProductIngestionIdentity"
           WHERE "productId" = ANY(${donorIds}::text[])
           ORDER BY "userId", platform, "identityKey"
        `;
    for (const identity of donorIdentities) {
      if (identity.userId !== manifest.tenantId) {
        errors.push(
          issue(
            "IDENTITY_TENANT_MISMATCH",
            `Identidade ${identity.platform}/${identity.identityKey} pertence a outro tenant.`,
            {
              productId: identity.productId ?? undefined,
              expected: manifest.tenantId,
              actual: identity.userId,
            },
          ),
        );
      }
    }
    const plannedIdentityKeys = [
      ...seed.identities.map((row) => ({
        platform: row.platform,
        identityKey: row.identityKey,
        productId: row.productId,
        status: row.status,
      })),
      ...manifest.groups.flatMap((group) =>
        group.duplicateIds.map((duplicateId) => ({
          platform: "DEXO",
          identityKey: `product:${duplicateId}`,
          productId: group.ownerId,
          status: "CONFIRMED" as const,
        })),
      ),
    ];
    const groupByMember = new Map<string, MergeManifestGroup>();
    for (const group of manifest.groups) {
      for (const id of [group.ownerId, ...group.duplicateIds])
        groupByMember.set(id, group);
    }
    const listingByKey = new Map(
      listings.map((listing) => [
        `${listing.platform}\u0000listing:${listing.marketplaceAccountId}:${listing.externalListingId}`,
        listing,
      ]),
    );
    for (const identity of seed.identities) {
      if (!identity.identityKey.startsWith("listing:")) continue;
      const listing = listingByKey.get(
        `${identity.platform}\u0000${identity.identityKey}`,
      );
      const group = listing ? groupByMember.get(listing.productId) : undefined;
      if (!listing || !group || identity.productId !== group.ownerId) {
        errors.push(
          issue(
            "LISTING_ALIAS_NOT_LIVE",
            `Alias ${identity.platform}/${identity.identityKey} não corresponde a listing live do owner canônico.`,
            { expected: identity, actual: listing ?? null },
          ),
        );
      }
    }
    const existingPlanned = plannedIdentityKeys.length
      ? apply
        ? await tx.$queryRaw<ExistingIdentity[]>`
          SELECT "userId", platform, "identityKey", "productId", status
            FROM "ProductIngestionIdentity" i
           WHERE i."userId" = ${manifest.tenantId}
             AND EXISTS (
               SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(
                 plannedIdentityKeys.map((row) => ({
                   platform: row.platform,
                   identity_key: row.identityKey,
                 })),
               )}::jsonb)
                 AS x(platform TEXT, identity_key TEXT)
                WHERE x.platform = i.platform AND x.identity_key = i."identityKey"
             )
           ORDER BY platform, "identityKey"
           FOR UPDATE
        `
        : await tx.$queryRaw<ExistingIdentity[]>`
          SELECT "userId", platform, "identityKey", "productId", status
            FROM "ProductIngestionIdentity" i
           WHERE i."userId" = ${manifest.tenantId}
             AND EXISTS (
               SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(
                 plannedIdentityKeys.map((row) => ({
                   platform: row.platform,
                   identity_key: row.identityKey,
                 })),
               )}::jsonb)
                 AS x(platform TEXT, identity_key TEXT)
                WHERE x.platform = i.platform AND x.identity_key = i."identityKey"
             )
           ORDER BY platform, "identityKey"
        `
      : [];
    const plannedByKey = new Map(
      plannedIdentityKeys.map((row) => [
        `${row.platform}\u0000${row.identityKey}`,
        row,
      ]),
    );
    for (const existing of existingPlanned) {
      const planned = plannedByKey.get(
        `${existing.platform}\u0000${existing.identityKey}`,
      )!;
      const existingCanonical = existing.productId
        ? (groupByMember.get(existing.productId)?.ownerId ?? existing.productId)
        : null;
      const incompatibleProduct =
        existingCanonical &&
        planned.productId &&
        existingCanonical !== planned.productId;
      const ambiguousToCertain =
        existing.status === "AMBIGUOUS" && planned.status !== "AMBIGUOUS";
      const confirmedToObserved =
        existing.status === "CONFIRMED" && planned.status === "OBSERVED";
      if (incompatibleProduct || ambiguousToCertain || confirmedToObserved) {
        errors.push(
          issue(
            "IDENTITY_CONFLICT",
            `Identidade existente ${existing.platform}/${existing.identityKey} contradiz o seed.`,
            {
              expected: planned,
              actual: existing,
            },
          ),
        );
      }
    }
  }
  return {
    errors,
    products,
    listings,
    stockLogs,
    stockSyncJobs,
    identityTablePresent,
  };
}

async function backupUnderLock(
  tx: Prisma.TransactionClient,
  manifest: MergeManifest,
  seed: IdentitySeed,
  metadata: Record<string, unknown>,
  outputDir: string,
): Promise<{ file: string; sha256: string; rows: Record<string, number> }> {
  const ids = sortedUnique(
    manifest.groups.flatMap((group) => [group.ownerId, ...group.duplicateIds]),
  );
  const listingIds = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ProductListing" WHERE "productId" = ANY(${ids}::text[]) ORDER BY id
  `;
  const selectedListingIds = listingIds.map((row) => row.id);
  const read = async (table: string): Promise<unknown[]> => {
    // This function is deliberately not generic SQL. Callers below select
    // from a fixed allow-list so no table/user data is interpolated into SQL.
    switch (table) {
      case "Product":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(p) AS row FROM "Product" p WHERE p.id = ANY(${ids}::text[]) ORDER BY p.id`
        ).map((r) => r.row);
      case "ProductListing":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "ProductListing" x WHERE x."productId" = ANY(${ids}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "ProductCompatibility":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "ProductCompatibility" x WHERE x."productId" = ANY(${ids}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "StockLog":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "StockLog" x WHERE x."productId" = ANY(${ids}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "StockSyncJob":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "StockSyncJob" x WHERE x."productId" = ANY(${ids}::text[]) OR x."listingId" = ANY(${selectedListingIds}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "OrderItem":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "OrderItem" x WHERE x."productId" = ANY(${ids}::text[]) OR x."listingId" = ANY(${selectedListingIds}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "ReceivableItem":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "ReceivableItem" x WHERE x."productId" = ANY(${ids}::text[]) OR x."listingId" = ANY(${selectedListingIds}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "BudgetItem":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "BudgetItem" x WHERE x."productId" = ANY(${ids}::text[]) OR x."listingId" = ANY(${selectedListingIds}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "NfeItem":
        return (
          await tx.$queryRaw<
            Array<{ row: unknown }>
          >`SELECT to_jsonb(x) AS row FROM "NfeItem" x WHERE x."productId" = ANY(${ids}::text[]) ORDER BY x.id`
        ).map((r) => r.row);
      case "ProductIngestionIdentity":
        return (
          await tx.$queryRaw<Array<{ row: unknown }>>`
        SELECT to_jsonb(x) AS row FROM "ProductIngestionIdentity" x
         WHERE x."productId" = ANY(${ids}::text[])
            OR (x."userId" = ${manifest.tenantId} AND EXISTS (
              SELECT 1 FROM _catalog_merge_seed s
               WHERE s.platform = x.platform AND s.identity_key = x."identityKey"
            ))
            OR (x."userId" = ${manifest.tenantId} AND x.platform = 'DEXO'
                AND x."identityKey" = ANY(${manifest.groups.flatMap((group) => group.duplicateIds.map((id) => `product:${id}`))}::text[]))
         ORDER BY x."userId", x.platform, x."identityKey"
      `
        ).map((r) => r.row);
      default:
        throw new CliError(
          "BACKUP_TABLE_REFUSED",
          `Tabela de backup não autorizada: ${table}`,
        );
    }
  };
  const tables = [
    "Product",
    "ProductListing",
    "ProductCompatibility",
    "StockLog",
    "StockSyncJob",
    "OrderItem",
    "ReceivableItem",
    "BudgetItem",
    "NfeItem",
    "ProductIngestionIdentity",
  ];
  const payload: Record<string, unknown> = {};
  const rowCounts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await read(table);
    payload[table] = rows;
    rowCounts[table] = rows.length;
  }
  const artifact = {
    version: 1,
    kind: "catalog-duplicate-pre-apply-backup",
    createdAt: new Date().toISOString(),
    tenant: manifest.tenant,
    tenantId: manifest.tenantId,
    phase: "after-live-validation-and-locks-before-first-write",
    metadata,
    identitySeedRows: seed.identities.length,
    rowCounts,
    tables: payload,
  };
  const written = createExclusiveJson(
    outputDir,
    `catalog-duplicates-backup-${manifest.tenant}`,
    artifact,
  );
  return { ...written, rows: rowCounts };
}

async function applySetBased(
  tx: Prisma.TransactionClient,
  manifest: MergeManifest,
): Promise<NonNullable<TransactionResult["applied"]>> {
  const allIds = sortedUnique(
    manifest.groups.flatMap((group) => [group.ownerId, ...group.duplicateIds]),
  );
  const donorCount = manifest.groups.reduce(
    (total, group) => total + group.duplicateIds.length,
    0,
  );
  const donorReferenceRows = await tx.$queryRaw<
    Array<{ tableName: string; count: number }>
  >`
    SELECT 'ProductListing' AS "tableName", COUNT(*)::int AS count
      FROM "ProductListing" x JOIN _catalog_merge_map m ON m.duplicate_id = x."productId"
    UNION ALL SELECT 'ProductCompatibility', COUNT(*)::int
      FROM "ProductCompatibility" x JOIN _catalog_merge_map m ON m.duplicate_id = x."productId"
    UNION ALL SELECT 'StockLog', COUNT(*)::int
      FROM "StockLog" x JOIN _catalog_merge_map m ON m.duplicate_id = x."productId"
    UNION ALL SELECT 'StockSyncJob', COUNT(*)::int
      FROM "StockSyncJob" x JOIN _catalog_merge_map m ON m.duplicate_id = x."productId"
    UNION ALL SELECT 'ProductIngestionIdentity', COUNT(*)::int
      FROM "ProductIngestionIdentity" x JOIN _catalog_merge_map m ON m.duplicate_id = x."productId"
    ORDER BY "tableName"
  `;
  const expectedMoved = new Map(
    donorReferenceRows.map((row) => [row.tableName, Number(row.count)]),
  );
  const listingRows = await tx.$queryRaw<
    Array<{
      id: string;
      productId: string;
      platform: string;
      targetStock: number;
    }>
  >`
    SELECT pl.id, pl."productId", ma.platform::text AS platform,
           GREATEST(0, owner.stock - owner."reservedStock")::int AS "targetStock"
      FROM "ProductListing" pl
      JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
      LEFT JOIN _catalog_merge_map m ON m.duplicate_id = pl."productId"
      JOIN "Product" owner ON owner.id = COALESCE(m.owner_id, pl."productId")
     WHERE pl."productId" = ANY(${allIds}::text[])
     ORDER BY pl.id
  `;
  // collectValidation already holds every per-listing advisory lock before
  // taking the StockSyncJob table lock. Re-acquiring them here would obscure
  // the single, globally consistent lock order.
  const count = async (query: Promise<Array<{ count: number }>>) =>
    Number((await query)[0]?.count ?? 0);
  const movedListings = await count(tx.$queryRaw<Array<{ count: number }>>`
    WITH moved AS (
      UPDATE "ProductListing" x SET "productId" = m.owner_id
        FROM _catalog_merge_map m WHERE x."productId" = m.duplicate_id RETURNING x.id
    ) SELECT COUNT(*)::int AS count FROM moved
  `);
  const movedCompatibilities = await count(tx.$queryRaw<
    Array<{ count: number }>
  >`
    WITH moved AS (
      UPDATE "ProductCompatibility" x SET "productId" = m.owner_id
        FROM _catalog_merge_map m WHERE x."productId" = m.duplicate_id RETURNING x.id
    ) SELECT COUNT(*)::int AS count FROM moved
  `);
  const movedStockLogs = await count(tx.$queryRaw<Array<{ count: number }>>`
    WITH moved AS (
      UPDATE "StockLog" x SET "productId" = m.owner_id
        FROM _catalog_merge_map m WHERE x."productId" = m.duplicate_id RETURNING x.id
    ) SELECT COUNT(*)::int AS count FROM moved
  `);
  const movedStockSyncJobs = await count(tx.$queryRaw<Array<{ count: number }>>`
    WITH moved AS (
      UPDATE "StockSyncJob" x
         SET "productId" = m.owner_id,
             "targetStock" = GREATEST(0, owner.stock - owner."reservedStock"),
             "updatedAt" = NOW()
        FROM _catalog_merge_map m
        JOIN "Product" owner ON owner.id = m.owner_id
       WHERE x."productId" = m.duplicate_id
       RETURNING x.id
    ) SELECT COUNT(*)::int AS count FROM moved
  `);
  const transferredIdentities = await count(tx.$queryRaw<
    Array<{ count: number }>
  >`
    WITH moved AS (
      UPDATE "ProductIngestionIdentity" x
         SET "productId" = m.owner_id, "updatedAt" = NOW()
        FROM _catalog_merge_map m
       WHERE x."userId" = ${manifest.tenantId} AND x."productId" = m.duplicate_id
       RETURNING x."identityKey"
    ) SELECT COUNT(*)::int AS count FROM moved
  `);
  const actualMoved = new Map<string, number>([
    ["ProductListing", movedListings],
    ["ProductCompatibility", movedCompatibilities],
    ["StockLog", movedStockLogs],
    ["StockSyncJob", movedStockSyncJobs],
    ["ProductIngestionIdentity", transferredIdentities],
  ]);
  for (const [tableName, expected] of expectedMoved) {
    const actual = actualMoved.get(tableName);
    if (actual !== expected) {
      throw new CliError(
        "MOVE_COUNT_MISMATCH",
        `${tableName}: fusão moveu ${actual ?? "?"}; esperado sob lock ${expected}.`,
      );
    }
  }
  const manifestListingCount = manifest.groups.reduce(
    (sum, group) => sum + group.expected.listingIdsToMove.length,
    0,
  );
  const manifestStockLogCount = manifest.groups.reduce(
    (sum, group) => sum + group.expected.donorStockLogsToReparent,
    0,
  );
  const manifestStockSyncJobCount = manifest.groups.reduce(
    (sum, group) =>
      sum +
      group.expected.stockSyncJobsTouched.filter((job) =>
        group.duplicateIds.includes(job.productId),
      ).length,
    0,
  );
  if (
    movedListings !== manifestListingCount ||
    movedStockLogs !== manifestStockLogCount ||
    movedStockSyncJobs !== manifestStockSyncJobCount
  ) {
    throw new CliError(
      "MANIFEST_MOVE_COUNT_MISMATCH",
      `Contagens movidas divergiram do manifesto: listings ${movedListings}/${manifestListingCount}, StockLog ${movedStockLogs}/${manifestStockLogCount}, StockSyncJob ${movedStockSyncJobs}/${manifestStockSyncJobCount}.`,
    );
  }
  const tombstoneResult = await tx.$queryRaw<Array<{ count: number }>>`
    WITH upserted AS (
      INSERT INTO "ProductIngestionIdentity"
        ("userId", platform, "identityKey", "productId", status, "sellerSkus", "updatedAt")
      SELECT ${manifest.tenantId}, 'DEXO', 'product:' || m.duplicate_id,
             m.owner_id, 'CONFIRMED', ARRAY[]::text[], NOW()
        FROM _catalog_merge_map m
      ON CONFLICT ("userId", platform, "identityKey") DO UPDATE
        SET "productId" = EXCLUDED."productId", status = 'CONFIRMED', "updatedAt" = NOW()
      RETURNING "identityKey"
    ) SELECT COUNT(*)::int AS count FROM upserted
  `;
  const donorTombstonesSeeded = Number(tombstoneResult[0]?.count ?? 0);
  const seedResult = await tx.$queryRaw<Array<{ count: number }>>`
    WITH upserted AS (
      INSERT INTO "ProductIngestionIdentity"
        ("userId", platform, "identityKey", "productId", status, "sellerSkus", "updatedAt")
      SELECT ${manifest.tenantId}, s.platform, s.identity_key, s.product_id, s.status,
             ARRAY(SELECT DISTINCT jsonb_array_elements_text(s.seller_skus)), NOW()
        FROM _catalog_merge_seed s
      ON CONFLICT ("userId", platform, "identityKey") DO UPDATE SET
        "productId" = CASE
          WHEN EXCLUDED.status = 'AMBIGUOUS' THEN NULL
          ELSE EXCLUDED."productId"
        END,
        status = CASE
          WHEN EXCLUDED.status = 'AMBIGUOUS' THEN 'AMBIGUOUS'
          WHEN "ProductIngestionIdentity".status = 'CONFIRMED' AND EXCLUDED.status = 'OBSERVED' THEN 'CONFIRMED'
          ELSE EXCLUDED.status
        END,
        "sellerSkus" = EXCLUDED."sellerSkus",
        "updatedAt" = NOW()
      RETURNING "identityKey"
    ) SELECT COUNT(*)::int AS count FROM upserted
  `;
  const identitiesSeeded = Number(seedResult[0]?.count ?? 0);
  const expectedSeedRows = Number(
    (
      await tx.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM _catalog_merge_seed
      `
    )[0]?.count ?? 0,
  );
  if (
    identitiesSeeded !== expectedSeedRows ||
    donorTombstonesSeeded !== donorCount
  ) {
    throw new CliError(
      "IDENTITY_UPSERT_COUNT_MISMATCH",
      `Identidades gravadas divergiram do plano: seed ${identitiesSeeded}/${expectedSeedRows}, tombstones de auditoria ${donorTombstonesSeeded}/${donorCount}.`,
    );
  }

  const queueRows = listingRows.map((listing) => ({
    id: randomUUID(),
    listing_id: listing.id,
    product_id: manifest.groups.find(
      (group) =>
        group.ownerId === listing.productId ||
        group.duplicateIds.includes(listing.productId),
    )!.ownerId,
    platform: listing.platform,
    target_stock: listing.targetStock,
  }));
  let listingsQueued = 0;
  if (queueRows.length) {
    const queued = await tx.$queryRaw<Array<{ count: number }>>`
      WITH source AS (
        SELECT x.id, x.listing_id, x.product_id, x.platform, x.target_stock
          FROM jsonb_to_recordset(${JSON.stringify(queueRows)}::jsonb)
            AS x(id TEXT, listing_id TEXT, product_id TEXT, platform "Platform", target_stock INTEGER)
      ), upserted AS (
        INSERT INTO "StockSyncJob"
          (id, "productId", "listingId", platform, "targetStock", attempts, "nextRunAt", status, "lastError", "createdAt", "updatedAt")
        SELECT id, product_id, listing_id, platform, target_stock, 0, NOW(), 'PENDING', NULL, NOW(), NOW()
          FROM source
        ON CONFLICT ("listingId", status) DO UPDATE SET
          "productId" = EXCLUDED."productId", platform = EXCLUDED.platform,
          "targetStock" = EXCLUDED."targetStock", attempts = 0,
          "nextRunAt" = NOW(), "lastError" = NULL, "updatedAt" = NOW()
        RETURNING id
      ) SELECT COUNT(*)::int AS count FROM upserted
    `;
    listingsQueued = Number(queued[0]?.count ?? 0);
  }
  if (listingsQueued !== listingRows.length) {
    throw new CliError(
      "STOCK_SYNC_QUEUE_COUNT_MISMATCH",
      `Jobs PENDING preparados ${listingsQueued}; esperado ${listingRows.length}.`,
    );
  }
  const deletedRows = await tx.$queryRaw<Array<{ id: string }>>`
    DELETE FROM "Product" p USING _catalog_merge_map m
     WHERE p.id = m.duplicate_id AND p."userId" = ${manifest.tenantId}
     RETURNING p.id
  `;
  if (deletedRows.length !== donorCount) {
    throw new CliError(
      "DELETE_COUNT_MISMATCH",
      `Exclusão retornou ${deletedRows.length}; esperado ${donorCount}.`,
    );
  }
  return {
    groups: manifest.groups.length,
    donorsDeleted: deletedRows.length,
    moved: {
      listings: movedListings,
      compatibilities: movedCompatibilities,
      stockLogs: movedStockLogs,
      stockSyncJobs: movedStockSyncJobs,
      ingestionIdentities: transferredIdentities,
    },
    identitiesSeeded,
    donorTombstonesSeeded,
    listingsQueued,
  };
}

async function verifyApply(
  tx: Prisma.TransactionClient,
  manifest: MergeManifest,
  productsBefore: LockedProduct[],
): Promise<Record<string, unknown>> {
  const donors = sortedUnique(
    manifest.groups.flatMap((group) => group.duplicateIds),
  );
  const owners = manifest.groups.map((group) => group.ownerId);
  const remainingDonors = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Product" WHERE id = ANY(${donors}::text[]) ORDER BY id
  `;
  const wrongListings = await tx.$queryRaw<
    Array<{ id: string; productId: string }>
  >`
    SELECT pl.id, pl."productId" FROM "ProductListing" pl
     WHERE pl.id = ANY(${manifest.groups.flatMap((group) => group.expected.listingIdsToMove)}::text[])
       AND NOT EXISTS (
         SELECT 1 FROM _catalog_merge_expected_listing expected
          WHERE expected.listing_id = pl.id AND expected.owner_id = pl."productId"
       )
     ORDER BY pl.id
  `;
  const ownerRows = await tx.$queryRaw<
    Array<{ id: string; stock: number; reservedStock: number }>
  >`
    SELECT id, stock, "reservedStock" FROM "Product" WHERE id = ANY(${owners}::text[]) ORDER BY id
  `;
  const beforeById = new Map(
    productsBefore.map((product) => [product.id, product]),
  );
  const changedOwners = ownerRows.filter((owner) => {
    const before = beforeById.get(owner.id);
    return (
      !before ||
      owner.stock !== before.stock ||
      owner.reservedStock !== before.reservedStock
    );
  });
  const orphanRefs = await tx.$queryRaw<
    Array<{ tableName: string; count: number }>
  >`
    SELECT 'ProductListing' AS "tableName", COUNT(*)::int AS count FROM "ProductListing" WHERE "productId" = ANY(${donors}::text[])
    UNION ALL SELECT 'ProductCompatibility', COUNT(*)::int FROM "ProductCompatibility" WHERE "productId" = ANY(${donors}::text[])
    UNION ALL SELECT 'StockLog', COUNT(*)::int FROM "StockLog" WHERE "productId" = ANY(${donors}::text[])
    UNION ALL SELECT 'StockSyncJob', COUNT(*)::int FROM "StockSyncJob" WHERE "productId" = ANY(${donors}::text[])
    UNION ALL SELECT 'ProductIngestionIdentity', COUNT(*)::int FROM "ProductIngestionIdentity" WHERE "productId" = ANY(${donors}::text[])
    ORDER BY "tableName"
  `;
  const nonZeroOrphans = orphanRefs.filter((row) => Number(row.count) !== 0);
  const identityVerification = await tx.$queryRaw<
    Array<{
      platform: string;
      identityKey: string;
      expectedProductId: string | null;
      expectedStatus: string;
      expectedSellerSkus: string[];
      actualProductId: string | null;
      actualStatus: string | null;
      actualSellerSkus: string[] | null;
    }>
  >`
    SELECT s.platform, s.identity_key AS "identityKey",
           s.product_id AS "expectedProductId", s.status AS "expectedStatus",
           ARRAY(SELECT jsonb_array_elements_text(s.seller_skus) ORDER BY 1) AS "expectedSellerSkus",
           i."productId" AS "actualProductId", i.status AS "actualStatus",
           i."sellerSkus" AS "actualSellerSkus"
      FROM _catalog_merge_seed s
      LEFT JOIN "ProductIngestionIdentity" i
        ON i."userId" = ${manifest.tenantId}
       AND i.platform = s.platform
       AND i."identityKey" = s.identity_key
     ORDER BY s.platform, s.identity_key
  `;
  const wrongSeedIdentities = identityVerification.filter((row) => {
    const statusMatches =
      row.expectedStatus === "OBSERVED"
        ? row.actualStatus === "OBSERVED" || row.actualStatus === "CONFIRMED"
        : row.actualStatus === row.expectedStatus;
    const productMatches =
      row.expectedStatus === "AMBIGUOUS"
        ? row.actualProductId === null
        : row.actualProductId === row.expectedProductId;
    const actualSkus = sortedUnique(row.actualSellerSkus ?? []);
    const expectedSkus = sortedUnique(row.expectedSellerSkus);
    return (
      !statusMatches ||
      !productMatches ||
      !arraysEqual(expectedSkus, actualSkus)
    );
  });
  const wrongDonorTombstones = await tx.$queryRaw<
    Array<{
      duplicateId: string;
      ownerId: string;
      actualProductId: string | null;
      actualStatus: string | null;
    }>
  >`
    SELECT m.duplicate_id AS "duplicateId", m.owner_id AS "ownerId",
           i."productId" AS "actualProductId", i.status AS "actualStatus"
      FROM _catalog_merge_map m
      LEFT JOIN "ProductIngestionIdentity" i
        ON i."userId" = ${manifest.tenantId}
       AND i.platform = 'DEXO'
       AND i."identityKey" = 'product:' || m.duplicate_id
     WHERE i."productId" IS DISTINCT FROM m.owner_id
        OR i.status IS DISTINCT FROM 'CONFIRMED'
     ORDER BY m.duplicate_id
  `;
  if (
    remainingDonors.length ||
    wrongListings.length ||
    changedOwners.length ||
    nonZeroOrphans.length ||
    wrongSeedIdentities.length ||
    wrongDonorTombstones.length
  ) {
    throw new CliError(
      "POST_APPLY_VERIFICATION_FAILED",
      jsonStringify({
        remainingDonors,
        wrongListings,
        changedOwners,
        nonZeroOrphans,
        wrongSeedIdentities,
        wrongDonorTombstones,
      }),
    );
  }
  return {
    remainingDonors: 0,
    movedListingsAtCanonicalOwner: manifest.groups.reduce(
      (sum, group) => sum + group.expected.listingIdsToMove.length,
      0,
    ),
    ownerStocksChanged: 0,
    seedIdentitiesVerified: identityVerification.length,
    donorTombstonesVerified: donors.length,
    orphanReferences: Object.fromEntries(
      orphanRefs.map((row) => [row.tableName, Number(row.count)]),
    ),
  };
}

async function runTransaction(
  manifest: MergeManifest,
  seed: IdentitySeed,
  apply: boolean,
  outputDir: string,
  metadata: Record<string, unknown>,
  manifestSha256: string,
  identitySeedSha256: string,
  progress: TransactionResult,
): Promise<TransactionResult> {
  return prisma.$transaction(
    async (tx) => {
      if (apply) {
        // BulkListingJob creation takes the shared form of this gate and
        // revalidates Product ownership after it acquires the lock. A creator
        // already in flight commits before validation; a later creator wakes
        // after this merge and refuses deleted donor IDs.
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtext(${CATALOG_PRODUCT_MERGE_LOCK_KEY}))
        `;
      }
      await createPlanTempTables(tx, manifest, seed);
      progress.phases.push({
        phase: "temporary-plan",
        status: "ok",
        detail: { groups: manifest.groups.length },
      });
      const validation = await collectValidation(tx, manifest, seed, apply);
      progress.validationErrors = validation.errors;
      progress.phases.push({
        phase: "live-validation-under-lock",
        status: validation.errors.length ? "failed" : "ok",
        detail: { errors: validation.errors.length },
      });
      if (validation.errors.length || !apply) {
        return progress;
      }
      const backup = await backupUnderLock(
        tx,
        manifest,
        seed,
        metadata,
        outputDir,
      );
      progress.backup = backup;
      progress.phases.push({
        phase: "pre-apply-backup",
        status: "ok",
        detail: backup,
      });
      const applied = await applySetBased(tx, manifest);
      progress.applied = applied;
      progress.phases.push({
        phase: "set-based-apply",
        status: "ok",
        detail: applied,
      });
      const verification = await verifyApply(tx, manifest, validation.products);
      progress.verification = verification;
      progress.phases.push({
        phase: "post-apply-verification",
        status: "ok",
        detail: verification,
      });
      const audit = await tx.systemLog.create({
        data: {
          userId: manifest.tenantId,
          action: "CATALOG_DUPLICATE_MERGE_COMMITTED",
          resource: "CatalogMergeManifest",
          resourceId: manifestSha256,
          level: "INFO",
          message: `Fusão de catálogo validada: ${applied.donorsDeleted} donors em ${applied.groups} grupos`,
          details: {
            manifestSha256,
            identitySeedSha256,
            backup: progress.backup,
            applied,
            verification,
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      progress.commitAudit = {
        id: audit.id,
        action: "CATALOG_DUPLICATE_MERGE_COMMITTED",
        manifestSha256,
      };
      progress.phases.push({
        phase: "commit-audit",
        status: "ok",
        detail: progress.commitAudit,
      });
      return progress;
    },
    { maxWait: 30_000, timeout: 15 * 60_000 },
  );
}

function isDirectExecution(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  return (
    Boolean(entrypoint) &&
    pathToFileURL(path.resolve(entrypoint)).href === moduleUrl
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const startedAt = new Date();
  const options = parseMergeCliArgs(argv);
  assertWorkersDrainedForApply(options.apply);
  const databaseHost = assertProductionDatabaseHost(
    process.env.DATABASE_URL,
    options.allowAnyHost,
  );
  const manifestBuffer = fs.readFileSync(options.manifestPath);
  const seedBuffer = fs.readFileSync(options.identitySeedPath);
  const manifestDigest = sha256(manifestBuffer);
  const seedDigest = sha256(seedBuffer);
  if (options.apply && options.sha256 !== manifestDigest) {
    throw new CliError(
      "MANIFEST_SHA256_MISMATCH",
      `SHA-256 informado não corresponde ao manifesto (${manifestDigest}).`,
    );
  }
  if (options.apply && options.identitySha256 !== seedDigest) {
    throw new CliError(
      "IDENTITY_SHA256_MISMATCH",
      `SHA-256 informado não corresponde ao identity seed (${seedDigest}).`,
    );
  }
  const manifest = parseMergeManifest(
    JSON.parse(manifestBuffer.toString("utf8")),
  );
  const seed = parseIdentitySeed(
    JSON.parse(seedBuffer.toString("utf8")),
    manifest,
  );
  try {
    const users = await prisma.$queryRaw<Array<{ id: string; email: string }>>`
    SELECT id, email FROM "User" WHERE LOWER(email) = LOWER(${options.userEmail}) ORDER BY id
  `;
    if (users.length !== 1 || users[0].id !== manifest.tenantId) {
      throw new CliError(
        "USER_TENANT_MISMATCH",
        `E-mail informado não resolve univocamente o tenant ${manifest.tenantId}.`,
      );
    }
    const outputDir = path.resolve(process.cwd(), "scripts", "out");
    const metadata = {
      mode: options.apply ? "APPLY" : "DRY_RUN",
      manifestPath: options.manifestPath,
      manifestSha256: manifestDigest,
      identitySeedPath: options.identitySeedPath,
      identitySeedSha256: seedDigest,
      userEmail: options.userEmail,
      databaseHost,
    };
    let result: TransactionResult | undefined;
    const progress: TransactionResult = { validationErrors: [], phases: [] };
    let fatal: unknown;
    try {
      result = await runTransaction(
        manifest,
        seed,
        options.apply,
        outputDir,
        metadata,
        manifestDigest,
        seedDigest,
        progress,
      );
    } catch (error) {
      fatal = error;
      result = progress;
      const rolledBackAttempt = progress.applied;
      const rolledBackAudit = progress.commitAudit;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = rolledBackAudit
        ? await reconcileCommitOutcome({
            auditId: rolledBackAudit.id,
            tenantId: manifest.tenantId,
            manifestSha256: manifestDigest,
            identitySeedSha256: seedDigest,
          })
        : "rolled-back";
      if (outcome === "committed") {
        progress.phases.push({
          phase: "transaction",
          status: "committed-reconciled",
          detail: { message, commitAudit: rolledBackAudit },
        });
      } else {
        progress.applied = undefined;
        progress.verification = undefined;
        progress.commitAudit = undefined;
        progress.phases.push({
          phase: "transaction",
          status:
            outcome === "rolled-back"
              ? "rolled-back"
              : "commit-outcome-unknown",
          detail: {
            message,
            attemptedApply: rolledBackAttempt,
            attemptedAudit: rolledBackAudit,
          },
        });
      }
    }
    const report = {
      version: 1,
      kind: "catalog-duplicate-merge-report",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      tenant: manifest.tenant,
      tenantId: manifest.tenantId,
      metadata,
      plan: {
        groups: manifest.groups.length,
        donors: manifest.groups.reduce(
          (sum, group) => sum + group.duplicateIds.length,
          0,
        ),
        listingsToMove: manifest.groups.reduce(
          (sum, group) => sum + group.expected.listingIdsToMove.length,
          0,
        ),
        identities: seed.identities.length,
      },
      result,
      fatalError: fatal
        ? {
            name: fatal instanceof Error ? fatal.name : "Error",
            code: fatal instanceof CliError ? fatal.code : undefined,
            message: fatal instanceof Error ? fatal.message : String(fatal),
            stack: fatal instanceof Error ? fatal.stack : undefined,
          }
        : null,
    };
    let reportFile: { file: string; sha256: string };
    try {
      reportFile = createExclusiveJson(
        outputDir,
        `catalog-duplicates-${options.apply ? "apply" : "dryrun"}-${manifest.tenant}`,
        report,
      );
    } catch (reportError) {
      if (result?.commitAudit) {
        // The SystemLog row was inserted in the same transaction as the
        // merge. It is the durable source of truth when the filesystem report
        // cannot be written after COMMIT (ENOSPC, permissions, abrupt mount).
        console.error(
          jsonStringify({
            event: "catalog_duplicate_merge_committed_report_write_failed",
            committed: true,
            commitAudit: result.commitAudit,
            message:
              reportError instanceof Error
                ? reportError.message
                : String(reportError),
          }),
        );
        process.exitCode = 1;
        return;
      }
      throw reportError;
    }
    console.log(
      jsonStringify({
        mode: options.apply ? "APPLY" : "DRY_RUN",
        manifestSha256: manifestDigest,
        identitySeedSha256: seedDigest,
        report: reportFile,
        backup: result?.backup,
        validationErrors: result?.validationErrors.length ?? null,
        applied: result?.applied ?? null,
        fatal: report.fatalError,
      }),
    );
    if (fatal) {
      process.exitCode = 1;
      return;
    }
    if (result?.validationErrors.length) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    let fatalReport: { file: string; sha256: string } | null = null;
    try {
      fatalReport = createExclusiveJson(
        path.resolve(process.cwd(), "scripts", "out"),
        "catalog-duplicates-fatal",
        {
          version: 1,
          kind: "catalog-duplicate-merge-preflight-error",
          createdAt: new Date().toISOString(),
          error: {
            name: error instanceof Error ? error.name : "Error",
            code: error instanceof CliError ? error.code : undefined,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        },
      );
    } catch (reportError) {
      console.error(
        jsonStringify({
          event: "catalog_duplicate_merge_fatal_report_failed",
          message:
            reportError instanceof Error
              ? reportError.message
              : String(reportError),
        }),
      );
    }
    console.error(
      jsonStringify({
        event: "catalog_duplicate_merge_fatal",
        code: error instanceof CliError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
        report: fatalReport,
      }),
    );
    process.exitCode = 1;
  });
}
