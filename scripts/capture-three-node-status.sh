#!/usr/bin/env bash
set -euo pipefail
umask 077

for command in curl jq node mktemp; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }
done

: "${FIDUCIA_AWS_API:?set FIDUCIA_AWS_API to the private client-plane URL for laptop-aws-sim}"
: "${FIDUCIA_GCP_API:?set FIDUCIA_GCP_API to the private client-plane URL for laptop-gcp-sim}"
: "${FIDUCIA_AZURE_API:?set FIDUCIA_AZURE_API to the private client-plane URL for laptop-azure-sim}"
: "${FIDUCIA_INTERNAL_SECRET:?set FIDUCIA_INTERNAL_SECRET through the runner secret store}"
: "${FIDUCIA_ORG_ID:=den-3008-lab}"

urls=("${FIDUCIA_AWS_API%/}" "${FIDUCIA_GCP_API%/}" "${FIDUCIA_AZURE_API%/}")
providers=(aws gcp azure)
if [[ "${urls[0]}" == "${urls[1]}" || "${urls[0]}" == "${urls[2]}" || "${urls[1]}" == "${urls[2]}" ]]; then
  echo 'three distinct node API URLs are required' >&2
  exit 3
fi

output_dir="${1:-den-3008-raft-status}"
mkdir -p "$output_dir"

for i in 0 1 2; do
  provider="${providers[$i]}"
  base="${urls[$i]}"
  echo "probing $provider Fiducia node"

  curl --fail --silent --show-error --max-time 5 --retry 2 \
    "$base/healthz" >"$output_dir/$provider-health.json"
  jq -e '.status == "ok"' "$output_dir/$provider-health.json" >/dev/null

  curl --fail --silent --show-error --max-time 8 --retry 2 \
    "$base/readyz" >"$output_dir/$provider-ready.json"
  jq -e '.status == "ok" and .all_shards_running == true and ((.unresponsive_shards // []) | length == 0) and ((.storage_faulted_shards // []) | length == 0)' \
    "$output_dir/$provider-ready.json" >/dev/null

  curl --fail --silent --show-error --max-time 10 --retry 2 \
    -H "x-fiducia-internal-auth: $FIDUCIA_INTERNAL_SECRET" \
    -H "x-fiducia-org-id: $FIDUCIA_ORG_ID" \
    "$base/v1/status" >"$output_dir/$provider-status.json"
  jq -e '.service == "fiducia-node" and (.consensus | type == "object")' \
    "$output_dir/$provider-status.json" >/dev/null
done

node scripts/verify-three-node-status.mjs \
  "$output_dir/aws-status.json" \
  "$output_dir/gcp-status.json" \
  "$output_dir/azure-status.json" \
  | tee "$output_dir/verification.json"

jq -n \
  --arg issue DEN-3008 \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{linearIssue:$issue,capturedAt:$capturedAt,credentialFreeEvidence:true,providers:["aws","gcp","azure"]}' \
  >"$output_dir/manifest.json"

echo "captured redacted DEN-3008 healthy-state evidence in $output_dir"
