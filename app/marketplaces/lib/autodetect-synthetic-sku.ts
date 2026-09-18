import { createHash } from "node:crypto";

/**
 * A marketplace external ID is not globally unique: some channels scope it
 * to an account and different channels may reuse the same text. Keep generated
 * SKUs deterministic while including the full identity scope. The 24 hex
 * characters provide 96 bits and keep the final value within 32 characters,
 * including the longest supported seven-character prefix.
 */
export function accountScopedAutodetectSku(
  prefix: string,
  input: {
    platform: string;
    accountId: string;
    externalListingId: string;
  },
): string {
  const safePrefix =
    prefix
      .normalize("NFKD")
      .replace(/[^a-z0-9]/gi, "")
      .toUpperCase()
      .slice(0, 7) || "MP";
  const digest = createHash("sha256")
    .update(
      `${input.platform}\u0000${input.accountId}\u0000${input.externalListingId}`,
    )
    .digest("hex")
    .slice(0, 24);
  return `${safePrefix}-${digest}`;
}
