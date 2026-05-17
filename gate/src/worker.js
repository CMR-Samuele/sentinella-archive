/**
 * Sentinella Gate — Cloudflare Worker
 *
 * Unico punto di accesso ai dati. Repo privato, articoli su R2.
 * L'app NON contiene logica di autorizzazione: ogni richiesta passa di qui.
 *
 * Rotte:
 *   GET /health    → pubblica, liveness check
 *   GET /articles  → richiede `Authorization: Bearer <license-key>`
 *
 * Auth model:
 *   La license key È la chiave KV. Lookup per esistenza = autenticazione
 *   (nessun confronto stringa lato app → niente timing leak, niente segreto
 *   nel client). Revoca = delete della key in KV → 403 immediato (no TTL).
 *
 * Binding (wrangler.toml):
 *   env.LICENSES  KV   allowlist
 *   env.ARCHIVE   KV   archivio (chiave "current" = articles.json)
 */

const ARCHIVE_KEY = "current";

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, env, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors(env),
      ...extra,
    },
  });
}

/** Estrae il bearer token, o null */
function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, ts: new Date().toISOString() }, 200, env);
    }

    if (url.pathname === "/articles") {
      if (req.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405, env);
      }

      const key = bearer(req);
      if (!key) {
        return json({ error: "missing_license_key" }, 401, env);
      }

      // Lookup allowlist. Chiave assente → null → 403.
      const raw = await env.LICENSES.get(key);
      if (raw === null) {
        return json({ error: "invalid_or_revoked" }, 403, env);
      }

      let lic;
      try {
        lic = JSON.parse(raw);
      } catch {
        return json({ error: "invalid_or_revoked" }, 403, env);
      }
      if (lic.active === false) {
        return json({ error: "invalid_or_revoked" }, 403, env);
      }

      // Autorizzato → servi archivio da KV.
      const body = await env.ARCHIVE.get(ARCHIVE_KEY, "stream");
      if (body === null) {
        return json({ error: "archive_unavailable" }, 503, env);
      }

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, max-age=60",
          "X-Licensed-To": lic.name || "unknown",
          ...cors(env),
        },
      });
    }

    return json({ error: "not_found" }, 404, env);
  },
};
