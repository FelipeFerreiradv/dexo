# Catalog duplicate merge artifacts

These scripts turn reviewed offline evidence into a signed merge plan. Run them
from the repository root.

The audit directory must contain, for each `tijuco` and `mk2` prefix, the
snapshot, reviewed merge manifest, Mercado Livre cache, and optional Shopee
cache expected by `build-identity-seed.ts`.

```bash
npx tsx scripts/catalog-dedupe/build-identity-seed.ts /absolute/audit-directory
```

The builder writes `*-merge-evidence-manifest.json` and
`*-identity-seed-manifest.json`. Every gallery fingerprint contains typed
`memberProofs`. A group is omitted unless one gallery covers every member and a
legacy Mercado Livre origin has an independent matching proof from another
member.

Finalize each pair against the live database immediately before the maintenance
window:

```bash
npx tsx scripts/catalog-dedupe/finalize-live-manifest.ts \
  /absolute/audit-directory/tenant-merge-evidence-manifest.json \
  /absolute/audit-directory/tenant-identity-seed-manifest.json \
  /secure/output/tenant-final-manifest.json \
  /secure/output/tenant-final-seed.json
```

Finalization uses one repeatable-read transaction and revalidates product
attributes, complete product galleries, listing/account bindings, tenant
ownership, and confirmed listing aliases. It records every omitted group under
`liveFinalization.blocked` and parses both outputs with the same strict CLI
parser before writing them.

After calculating both SHA-256 values, use the operational runner. It performs
a dry-run while services are available, drains the sync worker before stopping
the API, applies the merge, and restores both processes even when apply fails.

```bash
bash scripts/catalog-dedupe/run-catalog-merge.sh \
  --manifest=/secure/output/tenant-final-manifest.json \
  --identity-seed=/secure/output/tenant-final-seed.json \
  --user-email=tenant@example.com \
  --sha256=<manifest-sha256> \
  --identity-sha256=<identity-seed-sha256>
```

The runner intentionally has no command that targets the frontend process.
