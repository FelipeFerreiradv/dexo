const axios = require("axios");
const crypto = require("crypto");

(async function () {
  const partnerId = 1221766;
  const api_path = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const redirect =
    "https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback";
  const encoded = encodeURIComponent(redirect);
  const key =
    "shpk63754d73717455534a7141455649414561517850664e6c4541415156634d";

  function hmac(str) {
    return crypto.createHmac("sha256", key).update(str).digest("hex");
  }

  const orders = [
    partnerId + api_path + timestamp + redirect,
    partnerId + api_path + timestamp + encoded,
    partnerId + api_path + encoded + timestamp,
    partnerId + timestamp + api_path + encoded,
  ];

  for (const base of orders) {
    const sig = hmac(base);
    const url = `https://partner.test-stable.shopeemobile.com${api_path}?partner_id=${partnerId}&redirect=${encoded}&timestamp=${timestamp}&sign=${sig}`;
    const r = await axios.get(url, { validateStatus: false });
    console.log(
      "base",
      base,
      "sig",
      sig,
      "status",
      r.status,
      "err",
      r.data.error,
    );
  }
})();
