const crypto = require("crypto");
const key = "shpk63754d73717455534a7141455649414561517850664e6c4541415156634d";
const stripped = key.replace(/^shpk/, "");
console.log("stripped", stripped);
const hmac = (s) =>
  crypto.createHmac("sha256", stripped).update(s).digest("hex");
const base =
  "1221766" + "/api/v2/shop/auth_partner" + Math.floor(Date.now() / 1000);
console.log("test", hmac(base));
