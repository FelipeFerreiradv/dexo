const axios = require("axios");
const crypto = require("crypto");
const partnerId = "1221766";
const api_path = "/api/v2/shop/auth_partner";
const timestamp = Math.floor(Date.now() / 1000).toString();
const redirect =
  "https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback";
const encoded = encodeURIComponent(redirect);
const key = "shpk63754d73717455534a7141455649414561517850664e6c4541415156634d";

function hmac(str) {
  return crypto.createHmac("sha256", key).update(str).digest("hex");
}
function sha(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

const elements = { partnerId, api_path, timestamp, redirect, encoded, key };
const names = Object.keys(elements);

// generate all permutations of subset orders with 3 or more elements
const perms = [];
function generate(current, remaining) {
  if (current.length >= 3) {
    perms.push(current);
  }
  remaining.forEach((r, i) => {
    const next = current.concat(r);
    const rem = remaining.slice(0, i).concat(remaining.slice(i + 1));
    generate(next, rem);
  });
}
generate([], names);

(async () => {
  for (const order of perms) {
    // try both hmac and sha
    for (const alg of ["hmac", "sha"]) {
      const parts = order.map((n) => elements[n]);
      const base = parts.join("");
      const sig = alg === "hmac" ? hmac(base) : sha(base);
      const url = `https://partner.test-stable.shopeemobile.com${api_path}?partner_id=${partnerId}&redirect=${encoded}&timestamp=${timestamp}&sign=${sig}`;
      try {
        const r = await axios.get(url, { validateStatus: false });
        if (r.status === 200) {
          console.log("SUCCESS", alg, order, sig, url, r.data);
          process.exit(0);
        }
      } catch (e) {}
    }
  }
  console.log("no success");
})();
