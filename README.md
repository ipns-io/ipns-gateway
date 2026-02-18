# ipns-gateway

Reference Cloudflare Worker + local Node server for IPNS-style gateway resolution.

This gateway resolves a name from an onchain registry contract, fetches content from IPFS by CID, and serves it over normal HTTPS.

## What It Supports

- `https://<name>.<apex>/...`
- `https://<sub>.<name>.<apex>/...` (subname mode)
- `https://<apex>/<name>/...` (path mode)
- Optional DNSLink fallback (`_dnslink.<host>` TXT)
- Optional branded apex landing page via `LANDING_CID`

Example: one registry name (`alice`) can resolve on many branded gateways:

- `alice.ipns.io`
- `alice.cid.run`
- `alice.nameipfs.com`

Same contract. Same CID. Different gateway front-doors.

## Files

- `worker.js` - Cloudflare Worker reference implementation
- `server.js` - local Node HTTP server implementation
- `wrangler.toml` - Worker config
- `Dockerfile` - local container run option

## Environment Variables

See `.env.example`.

Required:

- `BASE_RPC_URL`
- `CONTRACT_ADDRESS`

Common:

- `APEX_DOMAIN` (default: `ipns.io`)
- `IPFS_GATEWAY_ORIGIN` (default: `https://cloudflare-ipfs.com/ipfs/`)
- `ENABLE_DNSLINK` (`true|false`)
- `DNS_RESOLVER_URL`

Optional branding:

- `LANDING_CID`  
  If set, apex + `www` hosts serve `/ipfs/$LANDING_CID/index.html` (and other files under that CID path).

## Cloudflare Deploy

1. Deploy:

```bash
wrangler deploy
```

2. In Worker Variables, set env vars from `.env.example`.

3. Add routes for your zone:

- `example.com/*`
- `*.example.com/*`

4. In DNS for that zone, add proxied records:

- `A @ -> 192.0.2.1` (orange cloud)
- `A * -> 192.0.2.1` (orange cloud)

## Local Run

```bash
BASE_RPC_URL="https://sepolia.base.org" \
CONTRACT_ADDRESS="0x..." \
node server.js
```

Then test:

- `http://localhost:8787/alice/`

## Trust Note

The registry state is onchain; gateway delivery is a trust point.  
Users can switch gateways while keeping the same onchain name.
