const fs = require("fs");
const norm = (f) =>
  fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter((l) => /error TS\d+/.test(l))
    .map((l) =>
      l
        .replace(/^.*?\.claude[\\/]worktrees[\\/][^\\/]+[\\/]/, "")
        .replace(/\\/g, "/")
        .replace(/\(\d+,\d+\)/, ""),
    )
    .filter((l) => !l.startsWith(".next/"));
const [b, h] = [norm(process.argv[2]), norm(process.argv[3])];
const count = (arr) =>
  arr.reduce((m, x) => (m.set(x, (m.get(x) || 0) + 1), m), new Map());
const cb = count(b);
const ch = count(h);
const novos = [];
const sumiram = [];
for (const [k, v] of ch) {
  const d = v - (cb.get(k) || 0);
  for (let i = 0; i < d; i++) novos.push(k);
}
for (const [k, v] of cb) {
  const d = v - (ch.get(k) || 0);
  for (let i = 0; i < d; i++) sumiram.push(k);
}
console.log("base", b.length, "head", h.length);
console.log("NOVOS", novos.length);
novos.forEach((x) => console.log("  + " + x));
console.log("SUMIRAM", sumiram.length);
sumiram.forEach((x) => console.log("  - " + x));
