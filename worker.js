// SPDX-License-Identifier: Apache-2.0
// Cloudflare Workers reference gateway (Gateway Resolution Spec v0).

const SELECTOR_RESOLVE = "0x461a4478"; // resolve(string)
const SELECTOR_RESOLVE_SUB = "0x6422a748"; // resolveSub(string,string)
const TXT_RECORD_TYPE = 16;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(msg, status = 200) {
  return new Response(msg + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function normalizeLabel(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s.length === 0) return { ok: false, err: "empty" };
  if (s.length > 63) return { ok: false, err: "too long" };
  if (s.startsWith("-") || s.endsWith("-")) return { ok: false, err: "hyphen edge" };
  if (!/^[a-z0-9-]+$/.test(s)) return { ok: false, err: "invalid chars" };
  return { ok: true, value: s };
}

function u256be(n) {
  const out = new Uint8Array(32);
  let x = BigInt(n);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function pad32(buf) {
  const len = buf.length;
  const padded = Math.ceil(len / 32) * 32;
  if (padded === len) return buf;
  const out = new Uint8Array(padded);
  out.set(buf, 0);
  return out;
}

function bufToHex(buf) {
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return "0x" + s;
}

function hexToBuf(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function abiEncodeString(s) {
  const bytes = new TextEncoder().encode(s);
  const head = u256be(32);
  const len = u256be(bytes.length);
  const data = pad32(bytes);
  const out = new Uint8Array(96 + data.length - 32);
  out.set(head, 0);
  out.set(len, 32);
  out.set(data, 64);
  return out;
}

function abiEncodeResolve(name) {
  const args = abiEncodeString(name);
  return SELECTOR_RESOLVE + bufToHex(args).slice(2);
}

function abiEncodeResolveSub(name, label) {
  const nameBytes = new TextEncoder().encode(name);
  const labelBytes = new TextEncoder().encode(label);

  const tail1 = (() => {
    const len = u256be(nameBytes.length);
    const data = pad32(nameBytes);
    const out = new Uint8Array(32 + data.length);
    out.set(len, 0);
    out.set(data, 32);
    return out;
  })();

  const tail2 = (() => {
    const len = u256be(labelBytes.length);
    const data = pad32(labelBytes);
    const out = new Uint8Array(32 + data.length);
    out.set(len, 0);
    out.set(data, 32);
    return out;
  })();

  const head1 = u256be(64);
  const head2 = u256be(64 + tail1.length);

  const args = new Uint8Array(64 + tail1.length + tail2.length);
  args.set(head1, 0);
  args.set(head2, 32);
  args.set(tail1, 64);
  args.set(tail2, 64 + tail1.length);

  return SELECTOR_RESOLVE_SUB + bufToHex(args).slice(2);
}

function abiDecodeString(hex) {
  if (!hex || hex === "0x") return "";
  const buf = hexToBuf(hex);
  if (buf.length < 64) return "";
  const readU256 = (off) => {
    let x = 0n;
    for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(buf[off + i]);
    return x;
  };
  const offset = Number(readU256(0));
  if (buf.length < offset + 32) return "";
  const len = Number(readU256(offset));
  const start = offset + 32;
  if (buf.length < start + len) return "";
  const bytes = buf.slice(start, start + len);
  return new TextDecoder().decode(bytes);
}

async function rpcCall(rpcUrl, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const j = await resp.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

async function resolveCid(env, name, sub) {
  const data = sub ? abiEncodeResolveSub(name, sub) : abiEncodeResolve(name);
  const result = await rpcCall(env.BASE_RPC_URL, "eth_call", [{ to: env.CONTRACT_ADDRESS, data }, "latest"]);
  return abiDecodeString(result);
}

function splitHost(host, apexDomain) {
  const h = String(host || "").toLowerCase().split(":")[0];
  if (!h) return null;
  if (h === apexDomain) return { mode: "path" };
  if (h === `www.${apexDomain}`) return { mode: "path", forceName: "www" };
  if (!h.endsWith(`.${apexDomain}`)) return null;
  const left = h.slice(0, -(apexDomain.length + 1));
  const labels = left.split(".").filter(Boolean);
  if (labels.length === 1) return { mode: "subdomain", name: labels[0], sub: "" };
  if (labels.length === 2) return { mode: "subdomain", name: labels[1], sub: labels[0] };
  return { mode: "invalid" };
}

function defaultIndex(pathname) {
  if (pathname.endsWith("/")) return pathname + "index.html";
  if (pathname === "/") return "/index.html";
  return pathname;
}

function boolEnv(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function contentTypeForPath(p) {
  const lower = String(p || "").toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

function maybeQuotedTxtToString(raw) {
  const s = String(raw || "").trim();
  const parts = [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (parts.length > 0) return parts.join("");
  return s;
}

function parseDnslinkValue(txtValues) {
  for (const raw of txtValues) {
    const s = maybeQuotedTxtToString(raw);
    const m = s.match(/(?:^|\s)dnslink=([^\s]+)/i);
    if (m && m[1]) return m[1];
  }
  return "";
}

async function queryDnslink(env, hostname) {
  const resolver = (env.DNS_RESOLVER_URL || "https://cloudflare-dns.com/dns-query").trim();
  const q = `${resolver}?name=${encodeURIComponent(`_dnslink.${hostname}`)}&type=TXT`;
  const resp = await fetch(q, { headers: { accept: "application/dns-json" } });
  if (!resp.ok) return [];
  const j = await resp.json();
  const answers = Array.isArray(j.Answer) ? j.Answer : [];
  return answers
    .filter((a) => Number(a.type) === TXT_RECORD_TYPE && typeof a.data === "string")
    .map((a) => a.data);
}

async function resolveDnslinkTarget(env, hostname, depth = 0) {
  if (depth > 2) return null;
  const txtValues = await queryDnslink(env, hostname);
  const dnslink = parseDnslinkValue(txtValues);
  if (!dnslink) return null;

  if (dnslink.startsWith("/ipfs/")) {
    const cid = dnslink.slice("/ipfs/".length).split("/")[0];
    if (!cid) return null;
    return { kind: "ipfs", id: cid };
  }
  if (dnslink.startsWith("/ipns/")) {
    const id = dnslink.slice("/ipns/".length).split("/")[0];
    if (!id) return null;
    if (id.includes(".")) return resolveDnslinkTarget(env, id, depth + 1);
    return { kind: "ipns", id };
  }
  return null;
}

function wrapUpstreamResponse(upstreamResp, fetchPath, cacheControl) {
  const headers = new Headers(upstreamResp.headers);
  const ct = (headers.get("content-type") || "").toLowerCase();
  if (!ct || ct.startsWith("application/octet-stream")) headers.set("content-type", contentTypeForPath(fetchPath));
  headers.set("cache-control", cacheControl);
  headers.set("x-content-type-options", "nosniff");
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dnslinkEnabled = boolEnv(env.ENABLE_DNSLINK, false);

    if (url.pathname === "/healthz") {
      return json({
        ok: true,
        apexDomain: env.APEX_DOMAIN || "ipns.io",
        contractAddress: env.CONTRACT_ADDRESS,
        baseRpcUrl: env.BASE_RPC_URL,
        ipfsGatewayOrigin: env.IPFS_GATEWAY_ORIGIN || "https://cloudflare-ipfs.com/ipfs/",
        dnslinkEnabled,
        dnsResolverUrl: env.DNS_RESOLVER_URL || "https://cloudflare-dns.com/dns-query",
      });
    }

    const apex = (env.APEX_DOMAIN || "ipns.io").toLowerCase();
    const host = String(request.headers.get("host") || "").toLowerCase().split(":")[0];

    if ((host === apex || host === `www.${apex}`) && env.LANDING_CID) {
      const pathname = defaultIndex(url.pathname || "/");
      const origin = (env.IPFS_GATEWAY_ORIGIN || "https://cloudflare-ipfs.com/ipfs/").replace(/\/+$/, "") + "/";
      const upstream = `${origin}${env.LANDING_CID}${pathname}`;
      const upstreamResp = await fetch(upstream);
      if (!upstreamResp.ok) return text("landing content not found", 404);
      return wrapUpstreamResponse(upstreamResp, pathname, "public, max-age=60");
    }

    const hostInfo = splitHost(host, apex);
    if (!hostInfo && !dnslinkEnabled) return text("unknown host", 404);
    if (hostInfo.mode === "invalid") return text("unsupported subdomain depth", 404);

    let pathname = url.pathname || "/";
    let name = "";
    let sub = "";
    let resolvedCid = "";
    let cacheControl = "public, max-age=60, s-maxage=300, stale-while-revalidate=30";

    if (hostInfo && hostInfo.mode === "path") {
      const parts = pathname.split("/").filter(Boolean);
      if (hostInfo.forceName) {
        name = hostInfo.forceName;
        sub = "";
        pathname = "/" + parts.join("/");
        if (pathname === "//" || pathname === "") pathname = "/";
      } else {
        if (parts.length === 0) return text("missing name", 404);
        name = parts[0];
        sub = "";
        pathname = "/" + parts.slice(1).join("/");
        if (pathname === "/") pathname = "/";
      }
    } else {
      name = hostInfo.name;
      sub = hostInfo.sub;
    }

    if (hostInfo) {
      const nn = normalizeLabel(name);
      if (!nn.ok) return text("invalid name", 404);
      const sn = sub ? normalizeLabel(sub) : { ok: true, value: "" };
      if (!sn.ok) return text("invalid subname", 404);
      resolvedCid = await resolveCid(env, nn.value, sn.value || "");
      if (!resolvedCid) return text("name not found / expired / empty cid", 404);
    } else {
      const target = await resolveDnslinkTarget(env, host);
      if (!target) return text("dnslink not found", 404);
      if (target.kind === "ipfs") {
        resolvedCid = target.id;
        cacheControl = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=300";
      } else {
        cacheControl = "public, max-age=60, s-maxage=300, stale-while-revalidate=30";
        const nn = normalizeLabel(target.id);
        if (!nn.ok) return text("unsupported dnslink ipns target", 404);
        resolvedCid = await resolveCid(env, nn.value, "");
      }
      if (!resolvedCid) return text("name not found / expired / empty cid", 404);
    }

    const ipfsPath = defaultIndex(pathname);
    const origin = (env.IPFS_GATEWAY_ORIGIN || "https://cloudflare-ipfs.com/ipfs/").replace(/\/+$/, "") + "/";
    const upstream = `${origin}${resolvedCid}${ipfsPath}`;

    const cacheKey = new Request(upstream, request);
    const cache = caches.default;
    let resp = await cache.match(cacheKey);
    if (!resp) {
      const upstreamResp = await fetch(upstream);
      if (!upstreamResp.ok) return text("content not found on upstream gateway", 404);
      resp = wrapUpstreamResponse(upstreamResp, ipfsPath, cacheControl);
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    return resp;
  },
};
