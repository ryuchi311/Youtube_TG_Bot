import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const databaseName = "tubesignal-db";
const configPath = path.join(root, "wrangler.jsonc");
const config = JSON.parse(readFileSync(configPath, "utf8"));

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: options.interactive ? undefined : "utf8",
    stdio: options.interactive ? "inherit" : "pipe",
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (options.interactive) {
    if (result.status !== 0) throw new Error(`wrangler ${args[0]} failed with exit code ${result.status}.`);
    return "";
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `wrangler ${args[0]} failed.`);
  }
  return result.stdout || "";
}

function readDatabaseList() {
  const output = run(["d1", "list", "--json"]);
  const start = output.search(/[\[{]/);
  if (start < 0) throw new Error("Could not read the D1 database list returned by Wrangler.");
  const data = JSON.parse(output.slice(start));
  return Array.isArray(data) ? data : data.databases || data.result || [];
}

function writeDatabaseId(databaseId) {
  config.d1_databases = config.d1_databases.map((binding) =>
    binding.binding === "DB" ? { ...binding, database_id: databaseId } : binding);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function importExistingConfig() {
  const localConfigPath = path.join(root, "data", "config.json");
  if (!existsSync(localConfigPath)) return;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      "Found data/config.json. Type IMPORT to copy its channels, destinations, settings, and upload cursors to Cloudflare (this replaces the Cloudflare config): ",
    );
    if (answer.trim() !== "IMPORT") {
      console.log("Skipped importing local configuration.");
      return;
    }
  } finally {
    prompt.close();
  }
  const localConfig = JSON.parse(readFileSync(localConfigPath, "utf8"));
  const sqlValue = JSON.stringify(localConfig).replaceAll("'", "''");
  const sqlPath = path.join(root, "data", ".cloudflare-import.sql");
  try {
    writeFileSync(sqlPath,
      `INSERT INTO app_state (id, config, lock_until) VALUES (1, '${sqlValue}', 0) ` +
      "ON CONFLICT(id) DO UPDATE SET config = excluded.config, lock_until = 0;\n");
    run(["d1", "execute", databaseName, "--remote", "--file", sqlPath], { interactive: true });
    console.log("Imported the local TubeSignal configuration into Cloudflare D1.");
  } finally {
    if (existsSync(sqlPath)) {
      const { rmSync } = await import("node:fs");
      rmSync(sqlPath);
    }
  }
}

function listedSecretNames() {
  const output = run(["secret", "list", "--format=json"]);
  const start = output.search(/[\[{]/);
  if (start < 0) throw new Error("Could not read Worker secrets from Wrangler. Run `npx wrangler secret list` and retry.");
  const secrets = JSON.parse(output.slice(start));
  if (!Array.isArray(secrets)) throw new Error("Wrangler returned an unexpected Worker secrets list.");
  return new Set(secrets.map((secret) => secret.name));
}

async function main() {
  try {
    run(["whoami"]);
  } catch {
    run(["login"], { interactive: true });
    run(["whoami"]);
  }

  try {
    let database = readDatabaseList().find((item) =>
      item.name === databaseName || item.database_name === databaseName);
    if (!database) {
      try {
        run(["d1", "create", databaseName, "--binding", "DB", "--use-remote", "--update-config"], { interactive: true });
        database = readDatabaseList().find((item) =>
          item.name === databaseName || item.database_name === databaseName);
      } catch (error) {
        database = readDatabaseList().find((item) =>
          item.name === databaseName || item.database_name === databaseName);
        if (!database) throw error;
      }
    }
    if (database) {
      const databaseId = database.uuid || database.database_id;
      if (!databaseId) throw new Error(`Wrangler did not return an ID for D1 database ${databaseName}.`);
      writeDatabaseId(databaseId);
    }

    run(["d1", "migrations", "apply", databaseName, "--remote"], { interactive: true });
    await importExistingConfig();
    run(["deploy"], { interactive: true });
    const existingSecrets = listedSecretNames();
    for (const name of ["ADMIN_PASSWORD", "TELEGRAM_BOT_TOKEN"]) {
      if (!existingSecrets.has(name)) {
        console.log(`Enter ${name} when Wrangler prompts. The value is sent directly to Cloudflare and is not saved in this project.`);
        run(["secret", "put", name], { interactive: true });
      }
    }
    console.log("TubeSignal is deployed. Open the Worker URL printed above to sign in.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

await main();
