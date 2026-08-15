#!/usr/bin/env node
// Checks that the running Node version satisfies package.json engines.node.
// Exits 2 with a usage hint on failure. Intended to run before `pnpm build`.

import fs from "node:fs";
import path from "node:path";

function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*|$)/.exec((raw ?? "").trim());
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
    prerelease: m[4] ? m[4].split(".").filter(Boolean) : null,
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const ai = a.prerelease[i],
      bi = b.prerelease[i];
    if (ai == null && bi == null) continue;
    if (ai == null) return -1;
    if (bi == null) return 1;
    if (ai === bi) continue;
    const aNum = /^[0-9]+$/.test(ai);
    const bNum = /^[0-9]+$/.test(bi);
    if (aNum && bNum) return Number.parseInt(ai, 10) < Number.parseInt(bi, 10) ? -1 : 1;
    if (aNum) return -1;
    if (bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

function satisfies(version, cond) {
  // Parse operator + version from first token
  const first = cond.split(" ")[0];
  let op = ">=";
  let verStr = cond;
  if (first.startsWith(">=")) {
    op = ">=";
    verStr = first.slice(2);
  } else if (first.startsWith(">")) {
    op = ">";
    verStr = first.slice(1);
  } else if (first.startsWith("<=")) {
    op = "<=";
    verStr = first.slice(2);
  } else if (first.startsWith("<")) {
    op = "<";
    verStr = first.slice(1);
  } else if (first.startsWith("=")) {
    op = "=|";
    verStr = first.slice(1);
  }
  if (cond.includes(" ")) {
    // chained condition like ">=22.22.3 <23"
    const parts = cond.split(/\s+/);
    let rangeOp = parts[0];
    let rangeVerStr = parts[0];
    if (rangeOp.startsWith(">=")) rangeVerStr = rangeOp.slice(2);
    else if (rangeOp.startsWith(">")) rangeVerStr = rangeOp.slice(1);
    const lower = parseVersion(rangeVerStr);
    if (!lower) return false;
    const upperStr = parts[1];
    let upperOp = "<";
    let upperVerStr = upperStr;
    if (upperStr.startsWith("<=")) {
      upperOp = "<=";
      upperVerStr = upperStr.slice(2);
    } else if (upperStr.startsWith("<")) {
      upperOp = "<";
      upperVerStr = upperStr.slice(1);
    }
    const upper = parseVersion(upperVerStr);
    if (!upper) return false;
    const c = compareSemver(version, lower);
    if (op === ">=" && c < 0) return false;
    if (op === ">" && c <= 0) return false;
    if (op === "<=" && c > 0) return false;
    if (op === "<" && c >= 0) return false;
    if (op === "=" || op === "=|") {
      if (c !== 0) return false;
    }
    const uc = compareSemver(version, upper);
    if (upperOp === "<" && uc >= 0) return false;
    if (upperOp === "<=" && uc > 0) return false;
    return true;
  }
  const ver = parseVersion(verStr);
  if (!ver) return false;
  if (op === ">=") return compareSemver(version, ver) >= 0;
  if (op === ">") return compareSemver(version, ver) > 0;
  if (op === "<=") return compareSemver(version, ver) <= 0;
  if (op === "<") return compareSemver(version, ver) < 0;
  if (op === "=" || op === "=|") return compareSemver(version, ver) === 0;
  return false;
}

function main() {
  const root = process.argv[2] ?? process.cwd();
  const pkgPath = path.join(root, "package.json");
  const required = JSON.parse(fs.readFileSync(pkgPath, "utf8")).engines?.node;
  if (!required) {
    console.log("engines.node not found in package.json; skipping.");
    process.exit(0);
  }
  const current = process.version;
  const currentParsed = parseVersion(current);
  if (!currentParsed) {
    console.error(`node --version = ${current} (not a parseable semver)`);
    process.exit(2);
  }
  const ranges = required.split("||").map((r) => r.trim());
  for (const range of ranges) {
    if (satisfies(currentParsed, range)) {
      console.log(`node: ${current} satisfies engines.node (${required})`);
      process.exit(0);
    }
  }
  console.error(`FATAL: Node ${current} does not satisfy engines.node: ${required}`);
  console.error("Install a compatible version first. For example:");
  console.error("  nvm install 24 && nvm use 24");
  process.exit(2);
}

main();
