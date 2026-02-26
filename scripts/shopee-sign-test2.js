const axios = require("axios");
const crypto = require("crypto");

(async function () {
  const partnerId = 1221766;
  const api_path = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const redirect =
    "https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback";
  const rawKey =
    "shpk63754d73717455534a7141455649414561517850664e6c4541415156634d";
  const key = rawKey.replace(/^shpk/, "");

  function hmac(str) {
    return crypto.createHmac("sha256", key).update(str).digest("hex");
  }

  const order = partnerId + api_path + timestamp + redirect;
  const sig = hmac(order);
  const url = `https://partner.test-stable.shopeemobile.com${api_path}?partner_id=${partnerId}&redirect=${encodeURIComponent(redirect)}&timestamp=${timestamp}&sign=${sig}`;
  console.log("trying url", url);
  try {
    const r = await axios.get(url, { validateStatus: false });
    console.log("status", r.status, "data", r.data);
  } catch (e) {
    console.log("error", e.message);
  }
})();
