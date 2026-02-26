import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const env = {
  APEX_DOMAIN: "ipns.io",
  BASE_RPC_URL: "https://rpc.example",
  CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000001",
  IPFS_GATEWAY_ORIGIN: "https://ipfs.example/ipfs/",
};

function encodeAbiStringReturn(value) {
  const bytes = new TextEncoder().encode(value);
  const paddedLen = Math.ceil(bytes.length / 32) * 32;
  const out = new Uint8Array(64 + paddedLen);
  out.set(new Uint8Array(32), 0);
  out[31] = 32; // offset to data
  out[63] = bytes.length;
  out.set(bytes, 64);
  return (
    "0x" +
    Array.from(out)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

test("rejects subname host inputs for launch", async () => {
  const req = new Request("https://docs.scavone.ipns.io/", {
    headers: { host: "docs.scavone.ipns.io" },
  });
  const resp = await worker.fetch(req, env, { waitUntil: () => {} });
  const body = await resp.text();
  assert.equal(resp.status, 410);
  assert.match(body, /subnames not supported for launch/i);
});

test("rejects dotted path names for launch", async () => {
  const req = new Request("https://ipns.io/docs.scavone/", {
    headers: { host: "ipns.io" },
  });
  const resp = await worker.fetch(req, env, { waitUntil: () => {} });
  const body = await resp.text();
  assert.equal(resp.status, 410);
  assert.match(body, /subnames not supported for launch/i);
});

test("parent-name resolution uses resolve(name) only", async () => {
  const selectors = [];
  globalThis.caches = {
    default: {
      match: async () => null,
      put: async () => {},
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("rpc.example")) {
      const payload = JSON.parse(String(init.body));
      const data = payload?.params?.[0]?.data ?? "";
      selectors.push(String(data).slice(0, 10));
      return new Response(
        JSON.stringify({ result: encodeAbiStringReturn("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi") }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };

  try {
    const req = new Request("https://scavone.ipns.io/", {
      headers: { host: "scavone.ipns.io" },
    });
    const resp = await worker.fetch(req, env, { waitUntil: () => {} });
    assert.equal(resp.status, 200);
    assert.deepEqual(selectors, ["0x461a4478"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
