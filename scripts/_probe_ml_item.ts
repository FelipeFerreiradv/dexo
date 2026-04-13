import "dotenv/config";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";

async function main() {
  const acc = await prisma.marketplaceAccount.findFirst({
    where: { userId: "cmn5yc4rn0000vsasmwv9m8nc", platform: "MERCADO_LIVRE", externalUserId: "1289108824" },
  });
  if (!acc) throw new Error("conta não encontrada");
  let token = acc.accessToken;
  if (acc.expiresAt < new Date()) {
    const r = await MLOAuthService.refreshAccessToken(acc.refreshToken);
    token = r.accessToken;
    await prisma.marketplaceAccount.update({ where: { id: acc.id }, data: { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: new Date(Date.now() + r.expiresIn * 1000) } });
  }
  const ids = await MLApiService.getSellerItemIds(token, acc.externalUserId!, "active", 3);
  console.log("ids", ids);
  for (const id of ids) {
    const r = await axios.get(`https://api.mercadolibre.com/items/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const d: any = r.data;
    console.log("---", id);
    console.log("status:", d.status, "sub_status:", d.sub_status);
    console.log("category:", d.category_id, "title:", d.title);
    console.log("shipping.dimensions:", d?.shipping?.dimensions);
    console.log("shipping.mode:", d?.shipping?.mode, "logistic_type:", d?.shipping?.logistic_type);
    const pkgAttrs = (d?.attributes || []).filter((a: any) => /PACKAGE|WEIGHT|HEIGHT|WIDTH|LENGTH/i.test(a.id));
    console.log("pkg attrs:", JSON.stringify(pkgAttrs, null, 2));
  }
  process.exit(0);
}
main().catch(e => { console.error(e?.response?.data || e); process.exit(1); });
