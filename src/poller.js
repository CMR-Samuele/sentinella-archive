/**
 * Sentinella Poller — src/poller.js
 *
 * Fetcha tutti i feed RSS in parallelo, filtra per Tesla,
 * deduplicazione per id (hash SHA-256 dell'URL), mantiene
 * max 5000 articoli ordinati per data decrescente (LIFO),
 * scrive data/articles.json.
 *
 * Dipendenze: fast-xml-parser (npm ci)
 * Runtime:    Node 18+ (fetch nativo)
 */

import { createHash }                from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { XMLParser }                 from "fast-xml-parser";

/* ─────────────────────────────────────────
   CONFIGURAZIONE FEED
───────────────────────────────────────── */
const FEEDS = [
  // Feed Tesla-specifici → non richiedono filtro keyword
  { url: "https://electrek.co/tag/tesla/feed/",                          id: "electrek",         name: "Electrek",            teslaOnly: true  },
  { url: "https://www.teslarati.com/feed/",                              id: "teslarati",        name: "Teslarati",           teslaOnly: true  },
  { url: "https://driveteslacanada.ca/feed/",                            id: "driveteslacanada", name: "Drive Tesla Canada",  teslaOnly: true  },
  { url: "https://techcrunch.com/tag/tesla/feed/",                       id: "techcrunch",       name: "TechCrunch",          teslaOnly: true  },
  { url: "https://teslamag.de/feed",                                     id: "teslamag",         name: "Teslamag.de",         teslaOnly: true  },
  { url: "https://www.youtube.com/feeds/videos.xml?user=TeslaMotors",   id: "tesla-youtube",    name: "Tesla YouTube",       teslaOnly: true  },

  // Feed generici EV/auto → filtrati per keyword "tesla"
  { url: "https://insideevs.com/rss/articles/all/",                      id: "insideevs",        name: "InsideEVs",           teslaOnly: false },
  { url: "https://cleantechnica.com/feed/",                              id: "cleantechnica",    name: "CleanTechnica",       teslaOnly: false },
  { url: "https://www.thedrive.com/feed",                                id: "thedrive",         name: "The Drive",           teslaOnly: false },
  { url: "https://carscoops.com/feed/",                                  id: "carscoops",        name: "Carscoops",           teslaOnly: false },
  { url: "https://chargedevs.com/feed/",                                 id: "chargedevs",       name: "ChargeDevs",          teslaOnly: false },
  { url: "https://www.electrive.com/feed/",                              id: "electrive",        name: "Electrive",           teslaOnly: false },
  { url: "https://cnevpost.com/feed/",                                   id: "cnevpost",         name: "CnEVPost",            teslaOnly: false },
  { url: "https://www.vaielettrico.it/feed/",                            id: "vaielettrico",     name: "Vaielettrico",        teslaOnly: false },
];

const DATA_PATH    = "data/articles.json";
const MAX_ARTICLES = 5000;
const EXCERPT_MAX  = 300;
const FETCH_TIMEOUT_MS = 15_000;

/* ─────────────────────────────────────────
   UTILITIES
───────────────────────────────────────── */

/** Genera un id stabile dall'URL (prime 16 hex di SHA-256) */
function hashUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** Rimuove tag HTML e decode entity comuni */
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")  // unwrap CDATA
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g,    " ")
    .trim();
}

/** Strip HTML + tronca a `max` caratteri */
function excerpt(raw, max = EXCERPT_MAX) {
  const t = stripHtml(raw || "");
  if (!t) return "";
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Normalizza qualsiasi valore di data in ISO string */
function toISO(raw) {
  if (!raw) return new Date().toISOString();
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {}
  return new Date().toISOString();
}

/** Ritorna true se text contiene "tesla" (case-insensitive) */
function hasTesla(text) {
  return (text || "").toLowerCase().includes("tesla");
}

/** Estrae stringa da un campo che può essere stringa o oggetto {#text} */
function str(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return v["#text"] || v["_"] || String(v);
  return String(v);
}

/* ─────────────────────────────────────────
   XML PARSER (RSS 2.0 + Atom)
───────────────────────────────────────── */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
  cdataPropName: "#cdata",
});

/* ─────────────────────────────────────────
   FETCH + PARSE SINGOLO FEED
───────────────────────────────────────── */
async function fetchFeed(feed) {
  const ac      = new AbortController();
  const timer   = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(feed.url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "SentinellaBot/1.0 (+https://github.com/sentinella-archive)",
        "Accept":     "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const doc = parser.parse(xml);

    /* ── RSS 2.0 ── */
    if (doc.rss?.channel) {
      const ch    = doc.rss.channel;
      const raw   = ch.item || [];
      const items = Array.isArray(raw) ? raw : [raw];

      return items
        .filter(item => {
          if (feed.teslaOnly) return true;
          return hasTesla(str(item.title)) || hasTesla(str(item.description)) || hasTesla(str(item["content:encoded"]));
        })
        .map(item => {
          const link = str(item.link) || str(item.guid);
          const title = str(item.title);
          const desc  = str(item["content:encoded"]) || str(item.description);
          if (!link || !title) return null;
          return {
            id:          hashUrl(link),
            headline:    stripHtml(title),
            excerpt:     excerpt(desc),
            publishedAt: toISO(str(item.pubDate) || str(item["dc:date"])),
            url:         link,
            sourceId:    feed.id,
            sourceName:  feed.name,
          };
        })
        .filter(Boolean);
    }

    /* ── Atom (YouTube, ecc.) ── */
    if (doc.feed) {
      const raw   = doc.feed.entry || [];
      const items = Array.isArray(raw) ? raw : [raw];

      return items
        .filter(entry => {
          if (feed.teslaOnly) return true;
          return hasTesla(str(entry.title)) || hasTesla(str(entry.summary)) || hasTesla(str(entry.content));
        })
        .map(entry => {
          const linkEl = entry.link;
          const link   = (Array.isArray(linkEl) ? linkEl[0] : linkEl)?.["@_href"] || str(linkEl);
          const title  = str(entry.title);
          const desc   = str(entry.summary) || str(entry.content) ||
                         str(entry["media:group"]?.["media:description"]);
          if (!link || !title) return null;
          return {
            id:          hashUrl(link),
            headline:    stripHtml(title),
            excerpt:     excerpt(desc),
            publishedAt: toISO(str(entry.published) || str(entry.updated)),
            url:         link,
            sourceId:    feed.id,
            sourceName:  feed.name,
          };
        })
        .filter(Boolean);
    }

    console.warn(`[poller] ${feed.id}: formato XML non riconosciuto`);
    return [];

  } catch (err) {
    clearTimeout(timer);
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    console.warn(`[poller] ${feed.id} fallito: ${reason}`);
    return [];
  }
}

/* ─────────────────────────────────────────
   MAIN
───────────────────────────────────────── */
async function main() {
  console.log(`\n[poller] ══ Avvio ${new Date().toISOString()} ══`);

  /* 1. Fetch tutti i feed in parallelo */
  const batches = await Promise.all(FEEDS.map(fetchFeed));
  const fresh   = batches.flat();
  console.log(`[poller] Articoli fetchati: ${fresh.length} (da ${FEEDS.length} feed)`);

  /* 2. Leggi archivio esistente */
  let archive = { lastUpdated: null, totalArticles: 0, articles: [] };
  try {
    const raw = readFileSync(DATA_PATH, "utf8");
    archive   = JSON.parse(raw);
    if (!Array.isArray(archive.articles)) archive.articles = [];
  } catch {
    console.log("[poller] Nessun archivio trovato — creazione nuovo file");
    mkdirSync("data", { recursive: true });
  }

  /* 3. Deduplicazione: tieni solo articoli con id non già presenti */
  const knownIds  = new Set(archive.articles.map(a => a.id));
  const newItems  = fresh.filter(a => !knownIds.has(a.id));
  console.log(`[poller] Nuovi articoli: ${newItems.length}`);

  if (newItems.length === 0) {
    console.log("[poller] Nessun aggiornamento — skip commit");
    return;
  }

  /* 4. Merge → sort decrescente per data → limite 5000 */
  const merged = [...newItems, ...archive.articles]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MAX_ARTICLES);

  /* 5. Scrivi JSON aggiornato */
  const output = {
    lastUpdated:    new Date().toISOString(),
    totalArticles:  merged.length,
    articles:       merged,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`[poller] ✓ Archivio scritto: ${merged.length} articoli totali`);

  /* Stampa breakdown per fonte */
  const bySource = {};
  newItems.forEach(a => { bySource[a.sourceId] = (bySource[a.sourceId] || 0) + 1; });
  Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .forEach(([src, n]) => console.log(`          ${src.padEnd(20)} +${n}`));
}

main().catch(err => {
  console.error("[poller] Errore fatale:", err);
  process.exit(1);
});
