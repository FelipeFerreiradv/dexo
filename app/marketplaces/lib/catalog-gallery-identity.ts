import { createHash } from "node:crypto";
import { Platform } from "@prisma/client";
import { normalizeSku } from "@/app/lib/sku";

export interface CatalogIdentityItem {
  platform: Platform;
  account: { id: string; userId: string };
  externalListingId: string;
  rawSku: string | null;
  title: string;
  imageUrls?: string[];
}

/** Full galleries only. A cover, logo or partial gallery cannot identify a piece. */
export function catalogGalleryKey(item: CatalogIdentityItem): string | null {
  if (
    item.platform !== Platform.MERCADO_LIVRE &&
    item.platform !== Platform.SHOPEE
  ) {
    return null;
  }
  const images = item.imageUrls ?? [];
  if (images.length < 2) return null;
  const ids: string[] = [];
  for (const image of images) {
    try {
      const url = new URL(image);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (item.platform === Platform.MERCADO_LIVRE) {
        if (!/(^|\.)mlstatic\.com$/i.test(url.hostname)) return null;
        const id = url.pathname.match(
          /(?:^|\/)D_(\d+-ML[A-Z]\d+_\d+)-[A-Z]\.(?:jpg|jpeg|png|webp)$/i,
        )?.[1];
        if (!id) return null;
        ids.push(id.toLowerCase());
      } else {
        if (
          !/(^|\.)shopee\.(?:com\.br|com|sg)$/i.test(url.hostname) &&
          !/(^|\.)img\.susercontent\.com$/i.test(url.hostname)
        )
          return null;
        const id = url.pathname.match(/^\/file\/([a-z0-9-]+)(?:_tn)?$/i)?.[1];
        if (!id) return null;
        ids.push(id.toLowerCase());
      }
    } catch {
      return null;
    }
  }
  const gallery = [...new Set(ids)].sort();
  if (gallery.length < 2) return null;
  // The title is validated separately with strict similarity and side/axis
  // guards. Keeping it in the hash made harmless word reordering create a new
  // lock and a second product for the exact same complete gallery.
  const digest = createHash("sha256")
    .update(JSON.stringify(gallery))
    .digest("hex");
  return `gallery:v1:${digest}`;
}

export function catalogIdentityEnabled(item: CatalogIdentityItem): boolean {
  return (process.env.CATALOG_IDENTITY_TENANT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(item.account.userId);
}

export function normalizedIdentitySku(value: string | null): string | null {
  return normalizeSku(value);
}
