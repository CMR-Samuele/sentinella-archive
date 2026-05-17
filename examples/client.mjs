#!/usr/bin/env node
/**
 * Client di esempio — auto-sync da GitHub (repo pubblico, no auth).
 *
 * Contratto per l'app:
 *   - a OGNI avvio l'app chiama loadArticles() → dati sempre freschi
 *   - nessun token, nessun git, nessun intervento utente
 *   - cache-bust per evitare la CDN edge di raw.githubusercontent (~5 min)
 *   - fallback: se offline, usa l'ultima copia locale salvata
 *
 * Uso standalone:
 *   node examples/client.mjs
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

const OWNER = "CMR-Samuele";
const REPO = "sentinella-archive";
const PATH = "data/articles.json";

// raw.githubusercontent ha cache CDN ~5 min. L'API contents bypassa quella
// cache (sempre ultimo commit), 60 req/h non autenticato → ampio per uso app.
const SOURCE_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
const SOURCE_RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${PATH}`;

const LOCAL_CACHE = "examples/.last-articles.json";
const TIMEOUT_MS = 10_000;

/**
 * Scarica l'archivio piu recente da GitHub.
 * Ritorna l'oggetto { lastUpdated, totalArticles, articles }.
 * Se la rete fallisce, ricade sull'ultima copia locale.
 */
export async function loadArticles() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    // 1° tentativo: API contents (no cache CDN, sempre ultimo commit)
    const res = await fetch(SOURCE_API, {
      signal: ac.signal,
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "SentinellaApp/1.0",
        "Cache-Control": "no-store",
      },
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    // Salva copia locale per uso offline
    try {
      writeFileSync(LOCAL_CACHE, JSON.stringify(data), "utf8");
    } catch {}
    return { ...data, _source: "github", _fetchedAt: new Date().toISOString() };
  } catch (err) {
    clearTimeout(t);
    // Fallback offline: ultima copia salvata
    if (existsSync(LOCAL_CACHE)) {
      const cached = JSON.parse(readFileSync(LOCAL_CACHE, "utf8"));
      return { ...cached, _source: "cache-locale", _error: err.message };
    }
    throw new Error(`Nessun dato: rete fallita (${err.message}) e nessuna cache locale`);
  }
}

// --- demo standalone ---
if (import.meta.url === pathToFileURL(argv[1]).href) {
  loadArticles()
    .then((d) => {
      console.log(`Fonte: ${d._source}`);
      console.log(`Articoli: ${d.totalArticles} | aggiornato ${d.lastUpdated}`);
      d.articles.slice(0, 5).forEach((a) =>
        console.log(`  • [${a.sourceName}] ${a.headline}`)
      );
    })
    .catch((e) => {
      console.error("Errore:", e.message);
      process.exit(1);
    });
}
