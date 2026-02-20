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
let i = 0;
let balance = 0;
const tries = []; // {startLine, waitingForBrace, openBalance, openLine, closed, closeLine}
let backtickExprStack = 0;
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
  } // backtick expressions
  if (inB) {
    if (c == "$" && nxt == "{") {
      backtickExprStack++;
      i += 2;
      balance++; // treat the '${' as an opening brace in expression
      // If there's a pending try waiting for its opening brace, assign it
      for (let k = tries.length - 1; k >= 0; k--) {
        if (tries[k].waitingForBrace) {
          tries[k].waitingForBrace = false;
          tries[k].openBalance = balance;
          tries[k].openLine = line;
          break;
        }
      }
      continue;
    }
    if (backtickExprStack > 0) {
      if (c == "{") {
        balance++;
      } else if (c == "}") {
        balance--;
        if (backtickExprStack > 0) {
          backtickExprStack--;
        }
      }
    }
    i++;
    continue;
  } // if not in string/comment
  // detect 'try' as whole word
  if (
    c == "t" &&
    s.substr(i, 3) == "try" &&
    !isWordChar(s[i - 1] || "") &&
    !isWordChar(s[i + 3] || "")
  ) {
    tries.push({ startLine: line, waitingForBrace: true });
    i += 3;
    continue;
  }
  if (c == "{") {
    balance++; // assign brace to last pending try
    for (let k = tries.length - 1; k >= 0; k--) {
      if (tries[k].waitingForBrace) {
        tries[k].waitingForBrace = false;
        tries[k].openBalance = balance;
        tries[k].openLine = line;
        break;
      }
    }
    i++;
    continue;
  }
  if (c == "}") {
    // before decrement, check if this closes any try
    for (let k = tries.length - 1; k >= 0; k--) {
      const t = tries[k];
      if (!t.waitingForBrace && t.openBalance === balance) {
        t.closed = true;
        t.closeLine = line;
        break;
      }
    }
    balance--;
    i++;
    continue;
  }
  i++;
}
// report
console.log("Overall balance:", balance);
tries.forEach((t, idx) => {
  console.log(
    `#${idx + 1} try at ${t.startLine} waiting=${t.waitingForBrace} openLine=${t.openLine || "-"} closed=${!!t.closed} closeLine=${t.closeLine || "-"}`,
  );
});

// find catches and their lines
const catchRegex = /^\s*\}\s*catch\s*\(/gm;
let m;
while ((m = catchRegex.exec(s))) {
  const upto = s.slice(0, m.index);
  const ln = upto.split(/\r?\n/).length;
  console.log("catch at line", ln + 1);
}
