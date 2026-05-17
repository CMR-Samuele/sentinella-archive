#!/usr/bin/env node
/**
 * Gestione license key — wrapper su `wrangler kv`.
 *
 * Le key vivono nel KV namespace `LICENSES` (binding in gate/wrangler.toml).
 * Eseguito dalla dir gate/ così wrangler usa --binding senza id manuale.
 *
 * Uso:
 *   node tools/keys.mjs add "Mario Rossi"     genera + abilita una key
 *   node tools/keys.mjs list                  elenca key attive
 *   node tools/keys.mjs disable <key>         sospende (active:false), reversibile
 *   node tools/keys.mjs revoke  <key>         elimina (hard, 403 immediato)
 *
 * Prerequisito: `wrangler login` già fatto (o CLOUDFLARE_API_TOKEN in env).
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "gate");
const BINDING = "LICENSES";

function wrangler(args) {
  return execFileSync("npx", ["--yes", "wrangler", ...args], {
    cwd: GATE_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
}

function genKey() {
  // 24 byte → 32 char base64url, opaco, non indovinabile
  return "snt_" + randomBytes(24).toString("base64url");
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "add": {
    if (!arg) {
      console.error("Uso: keys.mjs add \"Nome Utente\"");
      process.exit(1);
    }
    const key = genKey();
    const value = JSON.stringify({
      name: arg,
      active: true,
      createdAt: new Date().toISOString(),
    });
    wrangler(["kv", "key", "put", "--binding", BINDING, key, value]);
    console.log("\n✓ License key creata per:", arg);
    console.log("  KEY:", key);
    console.log("  Consegnala out-of-band (no email in chiaro se possibile).\n");
    break;
  }

  case "list": {
    const out = wrangler(["kv", "key", "list", "--binding", BINDING]);
    const keys = JSON.parse(out);
    if (!keys.length) {
      console.log("Nessuna key.");
      break;
    }
    for (const { name: k } of keys) {
      const v = JSON.parse(
        wrangler(["kv", "key", "get", "--binding", BINDING, k])
      );
      const state = v.active === false ? "DISABLED" : "active";
      console.log(`[${state}] ${k}  →  ${v.name}  (${v.createdAt})`);
    }
    break;
  }

  case "disable": {
    if (!arg) { console.error("Uso: keys.mjs disable <key>"); process.exit(1); }
    const v = JSON.parse(wrangler(["kv", "key", "get", "--binding", BINDING, arg]));
    v.active = false;
    wrangler(["kv", "key", "put", "--binding", BINDING, arg, JSON.stringify(v)]);
    console.log("✓ Sospesa:", arg, "(", v.name, ")");
    break;
  }

  case "revoke": {
    if (!arg) { console.error("Uso: keys.mjs revoke <key>"); process.exit(1); }
    wrangler(["kv", "key", "delete", "--binding", BINDING, arg]);
    console.log("✓ Eliminata (403 immediato):", arg);
    break;
  }

  default:
    console.log(
      "Comandi: add \"Nome\" | list | disable <key> | revoke <key>"
    );
    process.exit(1);
}
