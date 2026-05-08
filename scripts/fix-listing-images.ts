import "dotenv/config";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ensureMLMinImageSize } from "../app/marketplaces/services/image-resize.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

const USER_ID = process.env.IMPORT_USER_ID ?? "cmordubzu0000vst0cpn3kc41";
const ML_API = "https://api.mercadolibre.com";

interface AccountLite {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

async function getValidToken(account: AccountLite): Promise<string> {
  const now = Date.now();
  if (account.expiresAt && new Date(account.expiresAt).getTime() > now + 60_000) {
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken,
  );
  await prisma.marketplaceAccount.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    },
  });
  return refreshed.accessToken;
}

async function main(): Promise<void> {
  const listings = await prisma.productListing.findMany({
    where: {
      product: { userId: USER_ID },
      status: { notIn: ["error", "ERROR", "CLOSED", "closed"] },
      marketplaceAccount: { platform: "MERCADO_LIVRE" },
      externalListingId: { startsWith: "MLB" },
    },
    include: { product: true, marketplaceAccount: true },
  });

  console.log(`[fix-images] ${listings.length} listings ML ativos para reprocessar`);

  let ok = 0;
  let failed = 0;
  for (const listing of listings) {
    const imgs =
      listing.product.imageUrls && listing.product.imageUrls.length > 0
        ? listing.product.imageUrls.slice(0, 8)
        : listing.product.imageUrl
          ? [listing.product.imageUrl]
          : [];

    if (imgs.length === 0) {
      console.log(`  [skip] ${listing.externalListingId} sku=${listing.product.sku}: sem imagens`);
      continue;
    }

    const token = await getValidToken(listing.marketplaceAccount);

    const pictureIds: Array<{ id: string }> = [];
    for (const url of imgs) {
      try {
        const resp = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 15000,
        });
        const buf: Buffer = Buffer.from(resp.data);
        const processed = await ensureMLMinImageSize(buf);
        const baseName =
          new URL(url).pathname.split("/").pop() ?? "image.jpg";
        const fileName = baseName.replace(/\.png$/i, ".jpg");
        const r = await MLApiService.uploadPicture(token, processed, fileName);
        pictureIds.push({ id: r.id });
      } catch (e) {
        console.warn(
          `  [warn] upload falhou ${url}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (pictureIds.length === 0) {
      console.warn(
        `  [fail] ${listing.externalListingId} sku=${listing.product.sku}: nenhum picture id obtido`,
      );
      failed++;
      continue;
    }

    try {
      await axios.put(
        `${ML_API}/items/${listing.externalListingId}`,
        { pictures: pictureIds },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      console.log(
        `  [ok] ${listing.externalListingId} sku=${listing.product.sku} (${pictureIds.length} pics, conta=${listing.marketplaceAccount.accountName})`,
      );
      ok++;
    } catch (e) {
      const msg =
        (e as { response?: { data?: { message?: string } } }).response?.data?.message ??
        (e instanceof Error ? e.message : String(e));
      console.warn(`  [fail] PUT /items/${listing.externalListingId}: ${msg}`);
      failed++;
    }
  }

  console.log(`[fix-images] resumo: ok=${ok} fail=${failed} total=${listings.length}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
