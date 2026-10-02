import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const sourcePath = path.join(root, "data", "config.json");
const sqlPath = path.join(root, "data", ".cloudflare-import.sql");

if (!existsSync(sourcePath)) {
  console.error("No data/config.json found. Run this from a local TubeSignal installation with saved settings.");
  process.exitCode = 1;
} else {
  const prompt = createInterface({ input: stdin, output: stdout });
  let answer;
  try {
    answer = await prompt.question(
      "This replaces the current Cloudflare configuration. Type IMPORT to continue: ",
    );
  } finally {
    prompt.close();
  }
  if (answer.trim() !== "IMPORT") {
    console.log("Skipped importing local configuration.");
    process.exitCode = 1;
  } else {
    const config = JSON.parse(readFileSync(sourcePath, "utf8"));
    const sqlValue = JSON.stringify(config).replaceAll("'", "''");
    writeFileSync(sqlPath,
      `INSERT INTO app_state (id, config, lock_until) VALUES (1, '${sqlValue}', 0) ` +
      "ON CONFLICT(id) DO UPDATE SET config = excluded.config, lock_until = 0;\n");
    try {
      const result = spawnSync(process.execPath, [
        wrangler,
        "d1",
        "execute",
        "tubesignal-db",
        "--remote",
        "--file",
        sqlPath,
      ], { cwd: root, stdio: "inherit", windowsHide: false });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = result.status || 1;
      else console.log("Imported local TubeSignal configuration into Cloudflare D1.");
    } finally {
      rmSync(sqlPath, { force: true });
    }
  }
}
