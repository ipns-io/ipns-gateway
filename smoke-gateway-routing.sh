#!/usr/bin/env bash
set -euo pipefail

CIDRUN_HOST="${1:-https://www.cid.run}"
IPNS_HOST="${2:-https://www.ipns.io}"

check_header() {
  local label="$1"
  local url="$2"
  echo "== $label =="
  local headers
  headers="$(curl -sSI "$url")"
  echo "$headers" | grep -Eiq '^HTTP/2 200|^HTTP/1.1 200'
  echo "ok: HTTP 200"
  echo "$headers" | grep -qi '^x-ipfs-path:'
  echo "ok: x-ipfs-path present"
}

check_header "cid.run" "$CIDRUN_HOST/"
check_header "ipns.io" "$IPNS_HOST/"

echo "== launch policy: subnames unsupported =="
sub_headers="$(curl -sSI "https://docs.scavone.ipns.io/" || true)"
echo "$sub_headers" | grep -Eiq '^HTTP/2 410|^HTTP/1.1 410'
echo "ok: subname host rejected with 410"

echo "gateway routing smoke passed"
