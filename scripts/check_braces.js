const fs = require("fs");
const p = "app/marketplaces/usecases/listing.usercase.ts";
const s = fs.readFileSync(p, "utf8");
console.log("length", s.length);
const backticks = (s.match(/`/g) || []).length;
console.log("backticks", backticks);
const opens = (s.match(/{/g) || []).length;
const closes = (s.match(/}/g) || []).length;
console.log("{ count", opens, "} count", closes, "balance", opens - closes);
// show the line around reported error
const lines = s.split(/\r?\n/);
for (let i = 760; i <= 800; i++) {
  console.log(i + 1, lines[i] || "");
}
