const fs = require("fs");
const s = fs.readFileSync(
  "app/marketplaces/usecases/listing.usercase.ts",
  "utf8",
);
let inS = false,
  inD = false,
  inB = false,
  inLine = false,
  inBlock = false;
let line = 1;
const tries = [];
let i = 0;
let balance = 0;
function isWordChar(c) {
  return /[A-Za-z0-9_]/.test(c);
}
while (i < s.length) {
  const c = s[i];
  const nxt = s[i + 1];
  if (c == "\n") {
    inLine = false;
    line++;
    i++;
    continue;
  }
  if (inLine) {
    i++;
    continue;
  }
  if (inBlock) {
    if (c == "*" && nxt == "/") {
      inBlock = false;
      i += 2;
      continue;
    }
    i++;
    continue;
  }
  if (!inS && !inD && !inB && c == "/" && nxt == "/") {
    inLine = true;
    i += 2;
    continue;
  }
  if (!inS && !inD && !inB && c == "/" && nxt == "*") {
    inBlock = true;
    i += 2;
    continue;
  }
  if (!inD && !inB && c == "'") {
    inS = true;
    i++;
    continue;
  }
  if (inS) {
    if (c == "\\") {
      i += 2;
      continue;
    }
    if (c == "'") {
      inS = false;
    }
    i++;
    continue;
  }
  if (!inS && !inB && c == '\"') {
    inD = true;
    i++;
    continue;
  }
  if (inD) {
    if (c == "\\") {
      i += 2;
      continue;
    }
    if (c == '\"') {
      inD = false;
    }
    i++;
    continue;
  }
  if (!inS && !inD && c == "`") {
    inB = !inB;
    i++;
    continue;
  }
  if (inB) {
    if (c == "$" && nxt == "{") {
      // enter expression - treat like normal
    }
    i++;
    continue;
  } // not in string/comment
  // detect 'try' as whole word
  if (
    c == "t" &&
    s.substr(i, 3) == "try" &&
    !isWordChar(s[i - 1] || "") &&
    !isWordChar(s[i + 3] || "")
  ) {
    // found try
    // advance to next non-space
    let j = i + 3;
    while (j < s.length && /\s/.test(s[j])) j++; // expect '{' eventually
    // record a pending try with braceBalance we will catch when first '{' after this try occurs
    tries.push({ startLine: line, pending: true });
    i += 3;
    continue;
  }
  if (c == "{") {
    balance++; // if there is any pending try without assigned brace, assign this brace to last pending
    for (let k = tries.length - 1; k >= 0; k--) {
      if (tries[k].pending) {
        tries[k].pending = false;
        tries[k].openBalance = balance;
        tries[k].openIndex = i;
        tries[k].openLine = line;
        break;
      }
    }
    i++;
    continue;
  }
  if (c == "}") {
    // close brace
    // check if any try has openBalance equal to current balance (closing this brace)
    for (let k = tries.length - 1; k >= 0; k--) {
      const t = tries[k];
      if (!t.pending && t.openBalance === balance) {
        t.closeLine = line;
        t.closeIndex = i;
        t.closed = true;
        break;
      }
    }
    balance--;
    i++;
    continue;
  }
  i++;
}
// report all tries
if (tries.length === 0) {
  console.log("No try tokens found by scanner");
}
tries.forEach((t, idx) => {
  console.log(
    `#${idx + 1} try at line ${t.startLine} pending=${t.pending} openLine=${t.openLine || "-"} closed=${!!t.closed} closeLine=${t.closeLine || "-"}`,
  );
});
console.log("Balance:", balance);
