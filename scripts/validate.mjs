// Validates catalog.json against catalog.schema.json (structural checks only,
// no dependency needed) and verifies every repo is reachable and has at least
// one v* tag via `git ls-remote`. Exit code 1 on any failure.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../catalog.schema.json", import.meta.url), "utf8"));
const props = schema.properties.plugins.items.properties;
const required = schema.properties.plugins.items.required;

const errors = [];
const seen = new Set();

for (const [i, p] of (catalog.plugins ?? []).entries()) {
  const where = `plugins[${i}] (${p.name ?? "?"})`;
  for (const key of required) if (!(key in p)) errors.push(`${where}: missing "${key}"`);
  for (const key of Object.keys(p)) if (!(key in props)) errors.push(`${where}: unknown field "${key}"`);
  for (const key of ["name", "repo", "entry"]) {
    const pattern = props[key].pattern;
    if (p[key] !== undefined && !new RegExp(pattern).test(p[key]))
      errors.push(`${where}: "${key}" does not match ${pattern}`);
  }
  for (const cap of p.capabilities ?? [])
    if (!props.capabilities.items.enum.includes(cap)) errors.push(`${where}: unknown capability "${cap}"`);
  if (seen.has(p.name)) errors.push(`${where}: duplicate name`);
  seen.add(p.name);
  if (p.repo?.startsWith("-")) errors.push(`${where}: repo must not start with "-"`);

  if (errors.length === 0 && p.repo) {
    try {
      const out = execFileSync("git", ["ls-remote", "--tags", "--", p.repo], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!/refs\/tags\/v\d+\.\d+\.\d+/.test(out)) errors.push(`${where}: no v* semver tag in ${p.repo}`);
    } catch (error) {
      errors.push(`${where}: cannot reach ${p.repo}: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`catalog ok: ${catalog.plugins.length} plugin(s)`);
