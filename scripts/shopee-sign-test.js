const axios = require("axios");
const crypto = require("crypto");

(async function () {
  const partnerId = 1221766;
  const api_path = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const redirect =
    "https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback";
  const key =
    "shpk63754d73717455534a7141455649414561517850664e6c4541415156634d";

  function hmac(str) {
    return crypto.createHmac("sha256", key).update(str).digest("hex");
  }

  const combos = [];
  combos.push({ order: ["partner", "api", "time"], includeRedirect: false });
  combos.push({
    order: ["partner", "api", "time", "redirect"],
    includeRedirect: true,
  });
  combos.push({
    order: ["partner", "api", "redirect", "time"],
    includeRedirect: true,
  });
  combos.push({
    order: ["partner", "time", "api", "redirect"],
    includeRedirect: true,
  });
  combos.push({
    order: ["api", "partner", "time", "redirect"],
    includeRedirect: true,
  });
  combos.push({
    order: ["partner", "time", "redirect", "api"],
    includeRedirect: true,
  });
  combos.push({
    order: ["redirect", "partner", "api", "time"],
    includeRedirect: true,
  });

  for (const t of combos) {
    let parts = [];
    t.order.forEach((o) => {
      if (o === "partner") parts.push(partnerId);
      if (o === "api") parts.push(api_path);
      if (o === "time") parts.push(timestamp);
      if (o === "redirect") parts.push(t.includeRedirect ? redirect : "");
    });
    const base = parts.join("");
    const sig = hmac(base);
    const url = `https://partner.test-stable.shopeemobile.com${api_path}?partner_id=${partnerId}&redirect=${encodeURIComponent(redirect)}&timestamp=${timestamp}&sign=${sig}`;
    try {
      const r = await axios.get(url, { validateStatus: false });
      console.log(
        "order",
        t.order,
        "sig",
        sig,
        "status",
        r.status,
        "err",
        r.data.error,
      );
    } catch (e) {
      console.log("order", t.order, "error", e.message);
    }
  }
})();
