# Sentinella Gate — setup

Backend di protezione. Tutto passa di qui; l'app non contiene segreti.

```
[Action poller] --articles.json--> [R2: sentinella-data]
[App utente] --Bearer license-key--> [Worker gate] --KV allowlist--> 200 / 403
```

## Threat model

| Minaccia | Mitigazione |
|---|---|
| Sorgente pubblico → gate bypassabile | Repo **privato**. Nel client solo GATE_URL. |
| Dati scaricabili da github raw | Repo privato + dati serviti **solo** da R2 via Worker. |
| Key estratta dal binary store | Key è **per-utente**, revocabile singolarmente. Compromessa → `revoke`. |
| Confronto key lato client | Nessuno: la key È la chiave KV, lookup server-side. |
| Token rubato resta valido | Nessun JWT/TTL: revoca = delete KV = **403 immediato**. |

Non risolve: utente legittimo che redistribuisce i *dati* ricevuti. Mitigabile solo con watermarking/legale, fuori scope.

## Setup (una volta)

Prerequisito: account Cloudflare.

```bash
cd gate
npx wrangler login

# 1. Bucket R2
npx wrangler r2 bucket create sentinella-data

# 2. KV allowlist — copia l'id ritornato in wrangler.toml (campo id)
npx wrangler kv namespace create LICENSES

# 3. Deploy worker
npx wrangler deploy
# → annota l'URL: https://sentinella-gate.<tuo>.workers.dev
```

### GitHub secrets (per upload R2 dalla Action)

Cloudflare dashboard → My Profile → API Tokens → Create Token →
template **"Edit Cloudflare Workers"** o custom con permesso **R2 Storage: Edit**.

```bash
gh secret set CLOUDFLARE_API_TOKEN  --repo CMR-Samuele/sentinella-archive
gh secret set CLOUDFLARE_ACCOUNT_ID --repo CMR-Samuele/sentinella-archive
```

Poi: `gh workflow run poller.yml` → l'archivio finisce su R2.

## Gestione utenti

Dalla root del repo:

```bash
npm run key:add "Mario Rossi"     # genera key, consegnala a Mario
npm run key:list                  # vedi tutte
npm run key:disable -- snt_xxxxx  # sospendi (reversibile)
npm run key:revoke  -- snt_xxxxx  # elimina (403 immediato)
```

## Test

```bash
GATE_URL=https://sentinella-gate.<tuo>.workers.dev \
LICENSE_KEY=snt_xxxxx \
node examples/client.mjs
```

## Hardening opzionale

- Cloudflare dashboard → Worker → **Rate Limiting** per IP/key.
- `ALLOWED_ORIGIN` in `wrangler.toml`: se app web, restringi al tuo dominio (no `*`).
- WAF rules per geo/bot se serve.
