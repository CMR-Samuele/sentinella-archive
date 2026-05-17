#!/usr/bin/env node
/**
 * Client di esempio — riferimento per l'app store.
 *
 * Mostra l'UNICO contratto che l'app deve rispettare:
 *   - nessun dato/segreto hardcoded
 *   - solo GATE_URL (pubblico) + license key dell'utente
 *   - tutto passa dal Worker; senza key valida l'app non ha dati → inutile
 *
 * Uso:
 *   GATE_URL=https://sentinella-gate.<tuo>.workers.dev \
 *   LICENSE_KEY=snt_xxxxx \
 *   node examples/client.mjs
 */

const GATE_URL = process.env.GATE_URL;
const LICENSE_KEY = process.env.LICENSE_KEY;

if (!GATE_URL || !LICENSE_KEY) {
  console.error("Imposta GATE_URL e LICENSE_KEY in env.");
  process.exit(1);
}

async function main() {
  const res = await fetch(`${GATE_URL.replace(/\/$/, "")}/articles`, {
    headers: { Authorization: `Bearer ${LICENSE_KEY}` },
  });

  if (res.status === 401 || res.status === 403) {
    // L'app DEVE bloccarsi qui: nessun fallback, nessun dato locale.
    console.error(`Accesso negato (${res.status}). License key non valida o revocata.`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Errore gate: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Licenza: ${res.headers.get("X-Licensed-To")}`);
  console.log(`Articoli: ${data.totalArticles} (aggiornato ${data.lastUpdated})`);
  for (const a of data.articles.slice(0, 3)) {
    console.log(`  • [${a.sourceName}] ${a.headline}`);
  }
}

main().catch((e) => {
  console.error("Errore:", e.message);
  process.exit(1);
});
