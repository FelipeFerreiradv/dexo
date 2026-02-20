import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { Platform } from "@prisma/client";

async function main() {
  const externalUserId = process.argv[2];
  if (!externalUserId) {
    console.error(
      "Usage: npx tsx scripts/check-ml-capability.ts <externalUserId>",
    );
    process.exit(1);
  }

  console.log(
    `Looking up MarketplaceAccount for externalUserId=${externalUserId}`,
  );

  const account = await prisma.marketplaceAccount.findFirst({
    where: { externalUserId, platform: "MERCADO_LIVRE" },
  });

  if (!account) {
    console.error("No MarketplaceAccount found for that externalUserId");
    process.exit(2);
  }

  console.log("Found account:", {
    id: account.id,
    userId: account.userId,
    status: account.status,
    expiresAt: account.expiresAt,
  });

  // 1) Try to get user info
  try {
    const userInfo = await MLOAuthService.getUserInfo(account.accessToken);
    console.log("ML user info fetched:", userInfo);
    const sellerId = userInfo?.id?.toString();
    if (!sellerId) {
      console.error("Could not determine seller id from ML user info");
      process.exit(3);
    }

    // 2) Call lightweight seller items search (max 1) to detect restrictions
    try {
      const ids = await MLApiService.getSellerItemIds(
        account.accessToken,
        sellerId,
        "active",
        1,
      );
      console.log(
        `Seller item ids fetch succeeded (count=${ids.length}) — capability check PASSED`,
      );
      console.log(
        "Verdict: Creating a listing will likely succeed (account can list).",
      );
      process.exit(0);
    } catch (mlErr: any) {
      const m = mlErr instanceof Error ? mlErr.message : String(mlErr);
      console.warn("Capability check returned error:", m);
      if (
        m.toLowerCase().includes("vacation") ||
        m.toLowerCase().includes("férias") ||
        m.toLowerCase().includes("ferias") ||
        m.toLowerCase().includes("on vacation")
      ) {
        console.log(
          "Verdict: Account appears to be in vacation mode — creation will be blocked (app will mark account INACTIVE).",
        );
        process.exit(10);
      }
      if (
        m.includes("seller.unable_to_list") ||
        m.includes("User is unable to list")
      ) {
        console.log(
          "Verdict: Account restricted by Mercado Livre (seller.unable_to_list). Creation will be blocked and account will be marked ERROR.",
        );
        process.exit(11);
      }
      if (
        m.toLowerCase().includes("unauthorized") ||
        m.toLowerCase().includes("invalid access token")
      ) {
        console.log(
          "Verdict: Access token invalid or expired — creation will be blocked until token is refreshed or account reconnected.",
        );
        process.exit(12);
      }

      console.log(
        "Verdict: Unexpected ML error — creation may fail. See error above for details.",
      );
      process.exit(13);
    }
  } catch (infoErr: any) {
    const msg = infoErr instanceof Error ? infoErr.message : String(infoErr);
    console.warn("Failed to fetch ML user info:", msg);
    if (
      msg.toLowerCase().includes("unauthorized") ||
      msg.toLowerCase().includes("invalid access token")
    ) {
      console.log(
        "Verdict: Access token invalid or expired — creation will be blocked until token is refreshed or account reconnected.",
      );
      process.exit(12);
    }
    console.log(
      "Verdict: Could not determine ML user info — creation may fail.",
    );
    process.exit(14);
  }
}

main().catch((e) => {
  console.error("Script error", e);
  process.exit(99);
});
