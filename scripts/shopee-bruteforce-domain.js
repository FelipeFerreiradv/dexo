const axios = require("axios");
const crypto = require("crypto");
(async () => {
  const partner = "1221766";
  const api = "/api/v2/shop/auth_partner";
  const ts = Math.floor(Date.now() / 1000).toString();
  const redirect =
    "https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback";
  const domain = new URL(redirect).origin;
  const key =
    "shpk54695a7a437a436f456f7368515348726f5a5244614f554c61536251475a";

  function hmac(s) {
    return crypto.createHmac("sha256", key).update(s).digest("hex");
  }
  function sha(s) {
    return crypto.createHash("sha256").update(s).digest("hex");
  }

  const opts = [
    ["partner", "api", "ts"],
    ["partner", "api", "ts", "dom"],
    ["partner", "dom", "api", "ts"],
    ["dom", "partner", "api", "ts"],
    ["api", "partner", "ts", "dom"],
    ["partner", "api", "dom", "ts"],
  ];

  const vals = { partner, api, ts, dom: domain };

  for (const order of opts) {
    const base = order.map((o) => vals[o]).join("");
    const sig = hmac(base);
    const url = `https://partner.test-stable.shopeemobile.com${api}?partner_id=${partner}&redirect=${encodeURIComponent(redirect)}&timestamp=${ts}&sign=${sig}`;
    const r = await axios.get(url, { validateStatus: false });
    console.log(order, sig, r.status, r.data.error);
    if (r.status === 200) break;
  }
})();
