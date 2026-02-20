import axios from "axios";

async function tryRequest(name: string, opts: any = {}) {
  try {
    console.log(`\n--- ${name} ---`);
    const res = await axios.get(
      "https://api.mercadolibre.com/sites/MLB/categories",
      {
        headers: opts.headers,
        timeout: 10000,
      },
    );
    console.log("status:", res.status);
    console.log("headers:", res.headers);
    console.log(
      "data sample:",
      Array.isArray(res.data) ? res.data.slice(0, 3) : res.data,
    );
  } catch (err: any) {
    console.log(`error for ${name}:`);
    if (err.response) {
      console.log("status:", err.response.status);
      console.log("headers:", err.response.headers);
      console.log("data:", err.response.data);
    } else {
      console.log(err.message || err);
    }
  }
}

async function tryProxy(name: string, proxyUrl: string) {
  try {
    console.log(`\n--- ${name} via proxy ${proxyUrl} ---`);
    const url = `https://api.allorigins.win/raw?url=${encodeURIComponent("https://api.mercadolibre.com/sites/MLB/categories")}`;
    const res = await axios.get(url, { timeout: 10000 });
    console.log("status:", res.status);
    console.log(
      "data sample:",
      Array.isArray(res.data) ? res.data.slice(0, 3) : res.data,
    );
  } catch (err: any) {
    console.log(`proxy error for ${name}:`);
    if (err.response) {
      console.log("status:", err.response.status);
      console.log("data:", err.response.data);
    } else {
      console.log(err.message || err);
    }
  }
}

async function main() {
  await tryRequest("default");
  await tryRequest("with UA", {
    headers: { "User-Agent": "ghd-platform-test/1.0" },
  });
  await tryRequest("with Accept header", {
    headers: { Accept: "application/json" },
  });
  await tryRequest("with UA+Accept", {
    headers: {
      "User-Agent": "ghd-platform-test/1.0",
      Accept: "application/json",
    },
  });
  await tryProxy("allorigins");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
