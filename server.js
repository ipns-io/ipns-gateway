// SPDX-License-Identifier: Apache-2.0
// Minimal reference gateway: resolve name -> CID via Base RPC, then fetch CID content via an IPFS HTTP gateway.
//
// This is intentionally dependency-free so it can be self-hosted easily.
// It is a reference implementation for Gateway Resolution Spec v0.

import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8787);
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const IPFS_FETCH_MODE = (process.env.IPFS_FETCH_MODE || "upstream").toLowerCase(); // upstream | localfs
const IPFS_GATEWAY_ORIGIN =
  (process.env.IPFS_GATEWAY_ORIGIN || "https://cloudflare-ipfs.com/ipfs/").replace(/\/+$/, "") + "/";
const IPFS_LOCALFS_ROOT = process.env.IPFS_LOCALFS_ROOT || path.resolve("./localfs");
const APEX_DOMAIN = (process.env.APEX_DOMAIN || "ipns.io").toLowerCase();
const ENABLE_DNSLINK = /^(1|true|yes|on)$/i.test(process.env.ENABLE_DNSLINK || "");
const DNS_RESOLVER_URL = (process.env.DNS_RESOLVER_URL || "https://cloudflare-dns.com/dns-query").trim();

if (!BASE_RPC_URL) throw new Error("missing BASE_RPC_URL");
if (!CONTRACT_ADDRESS) throw new Error("missing CONTRACT_ADDRESS");

// Function selectors (keccak256(signature) first 4 bytes)
const SELECTOR_RESOLVE = "0x461a4478"; // resolve(string)
const SELECTOR_RESOLVE_SUB = "0x6422a748"; // resolveSub(string,string)
const TXT_RECORD_TYPE = 16;

function bad(res, code, msg) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(msg + "\n");
}

function okJson(res, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(body + "\n");
}

function normalizeLabel(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s.length === 0) return { ok: false, err: "empty" };
  if (s.length > 63) return { ok: false, err: "too long" };
  if (s.startsWith("-") || s.endsWith("-")) return { ok: false, err: "hyphen edge" };
  if (!/^[a-z0-9-]+$/.test(s)) return { ok: false, err: "invalid chars" };
  return { ok: true, value: s };
}

function hexToBuf(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("bad hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bufToHex(buf) {
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return "0x" + s;
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

function abiEncodeString(s) {
  const bytes = new TextEncoder().encode(s);
  const head = u256be(32); // offset to data
  const len = u256be(bytes.length);
  const data = pad32(bytes);
  const out = new Uint8Array(head.length + len.length + data.length);
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

  const head1 = u256be(64); // first tail starts after 2 head slots
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

async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const resp = await fetch(BASE_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const j = await resp.json();
  if (j.error) throw new Error(`rpc error: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

async function resolveCid(name, sub) {
  const data = sub ? abiEncodeResolveSub(name, sub) : abiEncodeResolve(name);
  const result = await rpcCall("eth_call", [{ to: CONTRACT_ADDRESS, data }, "latest"]);
  return abiDecodeString(result);
}

function splitHost(host) {
  const h = (host || "").toLowerCase().split(":")[0];
  if (!h) return null;
  if (h === APEX_DOMAIN || h === `www.${APEX_DOMAIN}`) {
    return { mode: "path" };
  }
  if (!h.endsWith(`.${APEX_DOMAIN}`)) return null;
  const left = h.slice(0, -(APEX_DOMAIN.length + 1)); // drop ".apex"
  const labels = left.split(".").filter(Boolean);
  if (labels.length === 1) return { mode: "subdomain", name: labels[0], sub: "" };
  if (labels.length === 2) return { mode: "subdomain", name: labels[1], sub: labels[0] };
  return { mode: "invalid" };
}

function normalizePath(pathname) {
  if (!pathname || pathname === "") return "/";
  return pathname;
}

function defaultIndex(pathname) {
  if (pathname.endsWith("/")) return pathname + "index.html";
  if (pathname === "/") return "/index.html";
  return pathname;
}

function contentTypeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".woff2") return "font/woff2";
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

async function queryDnslink(hostname) {
  const q = `${DNS_RESOLVER_URL}?name=${encodeURIComponent(`_dnslink.${hostname}`)}&type=TXT`;
  const resp = await fetch(q, { headers: { accept: "application/dns-json" } });
  if (!resp.ok) return [];
  const j = await resp.json();
  const answers = Array.isArray(j.Answer) ? j.Answer : [];
  return answers
    .filter((a) => Number(a.type) === TXT_RECORD_TYPE && typeof a.data === "string")
    .map((a) => a.data);
}

async function resolveDnslinkTarget(hostname, depth = 0) {
  if (depth > 2) return null;
  const txtValues = await queryDnslink(hostname);
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
    if (id.includes(".")) return resolveDnslinkTarget(id, depth + 1);
    return { kind: "ipns", id };
  }
  return null;
}

function safeJoin(root, ...parts) {
  const joined = path.resolve(root, ...parts.map((p) => p.replaceAll("\\", "/")));
  if (!joined.startsWith(root)) throw new Error("path traversal");
  return joined;
}

async function handle(req, res) {
  // Health endpoint should work regardless of Host header.
  if (req.method === "GET" && req.url && req.url.split("?")[0] === "/healthz") {
    return okJson(res, {
      ok: true,
      port: PORT,
      apexDomain: APEX_DOMAIN,
      contractAddress: CONTRACT_ADDRESS,
      baseRpcUrl: BASE_RPC_URL,
      ipfsFetchMode: IPFS_FETCH_MODE,
      ipfsGatewayOrigin: IPFS_GATEWAY_ORIGIN,
      ipfsLocalfsRoot: IPFS_LOCALFS_ROOT,
      dnslinkEnabled: ENABLE_DNSLINK,
      dnsResolverUrl: DNS_RESOLVER_URL,
    });
  }

  const host = String(req.headers.host || "").toLowerCase().split(":")[0];
  const hostInfo = splitHost(host);
  if (!hostInfo && !ENABLE_DNSLINK) return bad(res, 404, "unknown host");
  if (hostInfo.mode === "invalid") return bad(res, 404, "unsupported subdomain depth");

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = normalizePath(url.pathname);

  let name = "";
  let sub = "";

  if (hostInfo && hostInfo.mode === "path") {
    // /<name>/<rest>
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 0) return bad(res, 404, "missing name");
    name = parts[0];
    sub = "";
    pathname = "/" + parts.slice(1).join("/");
    if (pathname === "/") pathname = "/";
  } else if (hostInfo) {
    name = hostInfo.name;
    sub = hostInfo.sub;
  }

  let cid = "";
  let cacheControl = "public, max-age=60";

  if (hostInfo) {
    const nn = normalizeLabel(name);
    if (!nn.ok) return bad(res, 404, "invalid name");
    const sn = sub ? normalizeLabel(sub) : { ok: true, value: "" };
    if (!sn.ok) return bad(res, 404, "invalid subname");
    cid = await resolveCid(nn.value, sn.value || "");
    if (!cid) return bad(res, 404, "name not found / expired / empty cid");
  } else {
    const target = await resolveDnslinkTarget(host);
    if (!target) return bad(res, 404, "dnslink not found");
    if (target.kind === "ipfs") {
      cid = target.id;
      cacheControl = "public, max-age=3600";
    } else {
      const nn = normalizeLabel(target.id);
      if (!nn.ok) return bad(res, 404, "unsupported dnslink ipns target");
      cid = await resolveCid(nn.value, "");
      if (!cid) return bad(res, 404, "name not found / expired / empty cid");
    }
  }

  const ipfsPath = defaultIndex(pathname);
  if (IPFS_FETCH_MODE === "localfs") {
    const root = path.resolve(IPFS_LOCALFS_ROOT);
    const filePath = safeJoin(root, cid, "." + ipfsPath);
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "cache-control": cacheControl,
      "content-type": contentTypeFor(filePath),
      "x-content-type-options": "nosniff",
    });
    return void res.end(data);
  }

  const upstream = `${IPFS_GATEWAY_ORIGIN}${cid}${ipfsPath}`;
  let upstreamResp;
  try {
    upstreamResp = await fetch(upstream);
  } catch (e) {
    return bad(res, 500, `gateway error: fetch failed (${String(e)})`);
  }
  if (!upstreamResp.ok) return bad(res, 404, "content not found on upstream gateway");

  res.writeHead(200, {
    "cache-control": cacheControl,
    "content-type":
      upstreamResp.headers.get("content-type") && !upstreamResp.headers.get("content-type").startsWith("application/octet-stream")
        ? upstreamResp.headers.get("content-type")
        : contentTypeFor(ipfsPath),
    "x-content-type-options": "nosniff",
  });
  const ab = await upstreamResp.arrayBuffer();
  res.end(Buffer.from(ab));
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => bad(res, 500, `gateway error: ${err.message || String(err)}`));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ipns gateway listening on :${PORT}`);
});
