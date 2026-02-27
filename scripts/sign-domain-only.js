const crypto = require("crypto");
const partnerId = "1221766";
const api_path = "/api/v2/shop/auth_partner";
const timestamp = Math.floor(Date.now() / 1000).toString();
const redirectDomain = "https://abf1-179-193-9-250.ngrok-free.app";
const encoded = encodeURIComponent(redirectDomain);
const key = "shpk54695a7a437a436f456f7368515348726f5a5244614f554c61536251475a";

function hmac(str) {
  return crypto.createHmac("sha256", key).update(str).digest("hex");
}

const base = partnerId + api_path + timestamp + redirectDomain;
const sig = hmac(base);
const url = `https://partner.test-stable.shopeemobile.com${api_path}?partner_id=${partnerId}&redirect=${encodeURIComponent(redirectDomain)}&timestamp=${timestamp}&sign=${sig}`;
console.log("base", base);
console.log("sig", sig);
(async () => {
  const axios = require("axios");
  const r = await axios.get(url, { validateStatus: false });
  console.log("status", r.status, "data", r.data);
})();
