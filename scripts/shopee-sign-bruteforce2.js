const axios = require("axios");
const crypto = require("crypto");

(async () => {
  const partnerId = "1221766";
  const api_path = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const redirect =
    "https://abf1-179-193-9-250.ngrok-free.app/marketplace/shopee/callback";
  const encoded = encodeURIComponent(redirect);
  const key =
    "shpk63754d73717455534a7141455649414561517850664e6c4541415156634d";

  function sha(s) {
    return crypto.createHash("sha256").update(s).digest("hex");
  }

  const elements = { partnerId, api_path, timestamp, redirect, encoded, key };
  const names = Object.keys(elements);
  const perms = [];
  function gen(cur, rem) {
    if (cur.length >= 3) perms.push(cur);
    rem.forEach((r, i) => {
      gen(cur.concat(r), rem.slice(0, i).concat(rem.slice(i + 1)));
    });
  }
  gen([], names);
  for (const order of perms) {
    const parts = order.map((n) => elements[n]);
    const base = parts.join("");
    const sig = sha(base);
    const url = `https://partner.test-stable.shopeemobile.com${api_path}?partner_id=${partnerId}&redirect=${encoded}&timestamp=${timestamp}&sign=${sig}`;
    const r = await axios.get(url, { validateStatus: false });
    if (r.status === 200) {
      console.log("OK", order, sig);
      process.exit(0);
    }
    //console.log('try',order,r.status);
  }
  console.log("no success");
})();
