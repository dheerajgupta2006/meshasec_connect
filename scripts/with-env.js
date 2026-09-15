/**
 * Runs a command with `.env` values forced into the environment.
 *
 * `dotenv` deliberately does not overwrite variables that are already set, so a
 * stray `DATABASE_URL` in the shell silently wins over `.env` — which means a
 * migration can be pointed at the wrong database without any visible sign. This
 * wrapper inverts that precedence for local tooling only.
 *
 * Usage: node scripts/with-env.js npx prisma migrate status
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ENV_PATH = path.resolve(process.cwd(), ".env");

function parseEnv(contents) {
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    // Strip one layer of matching quotes, which is what dotenv does.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("usage: node scripts/with-env.js <command> [args...]");
  process.exit(1);
}

const overrides = fs.existsSync(ENV_PATH)
  ? parseEnv(fs.readFileSync(ENV_PATH, "utf8"))
  : {};

const host = (overrides.DATABASE_URL ?? "").match(/@([^/:?]+)/);
console.log(`with-env: DATABASE_URL host -> ${host === null ? "unset" : host[1]}`);

const result = spawnSync(args[0], args.slice(1), {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ...overrides },
});

process.exit(result.status === null ? 1 : result.status);
