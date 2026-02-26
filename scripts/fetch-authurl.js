const axios = require("axios");
(async () => {
  const r = await axios.post(
    "http://localhost:3333/marketplace/shopee/auth",
    {},
    { headers: { email: "fefelbf@gmail.com" } },
  );
  console.log("authUrl", JSON.stringify(r.data.authUrl));
  console.log("length", r.data.authUrl.length);
})();
