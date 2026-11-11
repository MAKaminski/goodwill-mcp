# goodwill-mcp — Proposal

Last updated 2026-11-11. Sanitized public version: no personal accounts, receipts or donation records.

## Summary

Build a local-first MCP server with **four tools**. The host model (Claude) reads the receipt and item photos. The server does no AI: it validates the data, values each item from a versioned thrift-shop price guide, keeps everything in one SQLite file, and produces year-end Form 8283 rows plus a PDF of the receipts.

This is an independent project, not affiliated with Goodwill Industries International or any regional Goodwill. Goodwill is the first **organization profile**; another charity is one more JSON price-guide file.

## Design decisions

| # | Decision | Why |
|---|---|---|
| 1 | Log **fair market value donated**, never "tax saved" | Noncash gifts are deductible only for itemizers. From 2026, only giving above 0.5% of AGI counts, and the non-itemizer deduction covers cash only |
| 2 | **No per-donation value cap** | The $500 figure on Form 8283 only decides whether three columns are required. Similar items are grouped for the year, so capping each donation gives up deduction and saves no paperwork |
| 3 | Track the **$5,000 similar-items line** | Above $5,000 for one item or one group of similar items in a year (all clothing, for example), a qualified appraisal is required |
| 4 | Photos are **files on disk** | Photos attached to a chat can't be archived. `intake_open` reads a watched folder so the paper trail is kept |

## The four tools

| Tool | Input | Processing | Output |
|---|---|---|---|
| `intake_open` | `dir?` (default inbox), `paths?` | Reads photos, rejects HEIC with a fix, resizes to 1568 px, hashes each file (SHA-256) | `intake_id`, image blocks, file list |
| `donation_create` | `intake_id?`, `org`, `donated_at`, `store`, `receipt_number?`, `items[{description, category, qty, condition, acquired?, cost_basis?}]`, `basis` low / mid / high | Validates. Drops items below good used condition. Prices from the guide. Saves. Archives photos | donation, year-to-date FMV, threshold flags |
| `donation_update` | `donation_id`, `patch` (items, values with `override_reason`, void) | Applies the change, writes an append-only revision | donation and diff |
| `donation_report` | `year`, `format` table / json / csv / form8283 / pdf / portal | Totals the year, groups similar items for Section A, builds the PDF packet. `portal` outputs description text and value for a charity's own donor-portal form | totals and file paths |

Also exposed: one MCP **prompt**, `log_donation` (what to extract and in what schema), and one **resource**, `valuation://goodwill/2026` (the price guide).

**Threshold flags (deterministic):**

| Trigger | Flag |
|---|---|
| Year's noncash total over $500 | Form 8283 Section A required |
| One item or group of similar items over $5,000 in the year | Section B and qualified appraisal |
| Group of similar items over $4,000 | Early warning: approaching the appraisal line |
| Single donation of $250 or more | Receipt must be archived (written acknowledgment) |

**Form 8283 Section A columns recorded:** (a) charity name and address, (c) description and condition, (d) date of contribution, (e) date acquired ("Various" allowed for groups held over 12 months), (f) how acquired, (g) cost or basis, (h) fair market value, (i) method ("Thrift shop value").

## Front-end

**Interface kind:** chat in Claude Desktop, Claude Code or Cowork (primary), plus the CLI `goodwill-mcp` (secondary, generated from the same registry). No web UI in v1.

**Launch & access**

| Item | Value |
|---|---|
| Claude Desktop | `.mcpb` from the GitHub release, or `{"mcpServers":{"goodwill":{"command":"npx","args":["-y","goodwill-mcp"]}}}` |
| Claude Code | `claude mcp add goodwill -- npx -y goodwill-mcp` |
| CLI | `npx goodwill-mcp donation report --year 2026` |
| Dev, clean clone | `pnpm i && pnpm dev` (MCP Inspector at `http://localhost:6274`) |
| Auth | None. Local process, local files |
| First screen | Chat: "Log my Goodwill drop-off". CLI: `goodwill-mcp --help` |

**CLI contract.** Grammar `goodwill-mcp <noun> <verb> [flags]`. Every command takes `--help` and `--json`. Data to stdout, logs to stderr. Exit codes: 0 ok, 1 user error, 2 system error.

| Command | Args / flags | Does | Returns | Calls |
|---|---|---|---|---|
| `goodwill-mcp intake open` | `--dir <path>` `--json` | Loads photos from the inbox | `IntakeResult` | `intake_open` |
| `goodwill-mcp donation create` | `--intake <id>` `--from-json <file>` `--basis low\|mid\|high` `--dry-run` | Saves a donation | `Donation` | `donation_create` |
| `goodwill-mcp donation update` | `<id>` `--set k=v` `--void` `--reason <text>` `--dry-run` `--yes` | Corrects or voids (void needs `--yes`) | `Donation` + diff | `donation_update` |
| `goodwill-mcp donation report` | `--year <yyyy>` `--format table\|json\|csv\|form8283\|pdf\|portal` | Year totals and exports | `Report` | `donation_report` |
| `goodwill-mcp valuation show` | `--org goodwill` `--year 2026` | Prints the price guide | `ValuationRate[]` | resource |
| `goodwill-mcp server start` | — | Starts the stdio server | — | — |
| `goodwill-mcp eval run` | `--model haiku\|sonnet` | Runs extraction evals | `EvalReport` | model API |

**Designed terminal session** (illustrative values)

```text
$ goodwill-mcp donation report --year 2026
DATE        STORE         ITEMS  FMV      RECEIPT
2026-03-14  Store #0412      12   $64.00  archived
2026-11-10  Store #0412       9   $86.00  archived
--------------------------------------------------
2026        2 donations · 21 items · $150.00 FMV
Form 8283   not required yet ($500 line) · $350.00 headroom
Clothing    $150.00 of $5,000 appraisal line

$ goodwill-mcp intake open
error HEIC_UNSUPPORTED: IMG_4412.HEIC
  fix: iPhone Settings > Camera > Formats > Most Compatible, or export as JPEG
$ echo $?
1
```

**States**

| Command | Empty | Loading | Error | Partial | Success |
|---|---|---|---|---|---|
| `intake open` | "Inbox empty" (exit 1) | stderr `resizing 2/3` | HEIC or unreadable file, named, with the fix | Receipt but no item photos: warns `items_from_receipt_only` | intake id and file table |
| `donation create` | — | — | `DUPLICATE_RECEIPT`, `NO_RATE_MATCH` | Unpriced items saved at $0 and flagged | donation, YTD total, flags |
| `donation report` | "No donations in 2026" | stderr `building pdf` | Unknown format (exit 1) | Missing receipts listed | totals and file paths |

## Back-end

- **State:** one SQLite file, `~/.goodwill-mcp/ledger.db` (Node's built-in `node:sqlite`). Photos in `~/.goodwill-mcp/archive/<sha256>.jpg`.
- Eight tables, all linked (see the ERD in [ARCHITECTURE.md](../ARCHITECTURE.md)).
- Money as integer cents. `receipt_sha256` unique. Indexes on `donation(org_id, donated_at)` and `donation_item(donation_id)`.
- Numbered SQL migrations run at startup. The price guide is versioned JSON in `guides/`; ranges differ by region, so the config selects a guide.
- Nothing is deleted automatically. The folder is the backup unit.

## Middleware

- MCP over stdio (JSON-RPC 2.0), `@modelcontextprotocol/sdk`, TypeScript.
- One registry, `commands.ts`, generates the MCP input schemas (Zod), the CLI flags and the README table.
- Idempotent: the same receipt hash returns the existing donation.
- Actionable error codes: `HEIC_UNSUPPORTED`, `BELOW_GOOD_CONDITION`, `DUPLICATE_RECEIPT`, `NO_RATE_MATCH`, `VALUE_OVER_GUIDE` (needs `override_reason`).
- No HTTP API in v1. Charity donor portals generally have no API, so registering a donation there stays a browser step outside this server; `--format portal` prepares the text.

## Middleware — AI

- **Routing:** photo extraction is done by the host model (Sonnet low recommended; Haiku low is enough for receipts). Valuation, thresholds and Form 8283 grouping are deterministic rules. Optional local path: Ollama `qwen2.5vl:7b` for offline logging.
- **Contract:** the host fills the `DonationDraft` schema; the server validates every field. A category must match a guide key or the item is saved at $0 with `NO_RATE_MATCH`.
- **Evals:** 20 synthetic receipt-and-photo sets with golden JSON. Pass bar: store and date exact 100%, category accuracy ≥ 90%, total FMV within ±10%.
- **Guardrails:** never claim tax savings; leave out items below good used condition; every override is written to `revision`.

## Infrastructure

- No container in v1. The host starts one Node ≥ 22.13 process over stdio.
- Sizing (est.): ~70 MB RSS idle, ~200 MB peak while resizing three 12 MP photos. TBD: measure with `/usr/bin/time -l`.
- One process per host session. After the first `npx` download, start to first output ≤ 300 ms.
- Data stays on the user's machine.
- CI: GitHub Actions runs lint, unit tests and an Inspector smoke test. A release publishes to npm with provenance, attaches the `.mcpb`, and updates the MCP Registry entry.

## Cost (estimates)

Rates in USD per 1M tokens (input / output): Sonnet $3 / $15, Haiku $1 / $5. Verify current pricing before relying on these.

Per donation: 3 photos (~1,600 tokens each) + ~2,200 tokens of prompt and schemas ≈ 7K input; ~1K output; 2 model calls.

| | Sonnet | Haiku |
|---|---|---|
| Call 1: extract + `donation_create` (7K in / 1K out) | $0.036 | $0.012 |
| Call 2, cached (1K fresh + 7K read / 0.2K out) | $0.008 | $0.003 |
| **Per donation, cached** | **$0.044** | **$0.015** |
| Per donation, uncached | $0.063 | $0.021 |

The server itself costs $0. At 12 donations a year on Sonnet: 12 × $0.044 = $0.53.

## Performance budget

| Layer | Component | Metric | Target | Est. | Measured with |
|---|---|---|---|---|---|
| Front-end | CLI | Start to first output | ≤ 300 ms | ~150 ms | `hyperfine` |
| Back-end | SQLite | Insert donation + items, p95 | ≤ 50 ms | ~5 ms | bench script |
| Back-end | SQLite | Year report query, p95 | ≤ 50 ms | < 10 ms | `EXPLAIN QUERY PLAN` |
| Middleware | `intake_open` | p95, 3 photos | ≤ 600 ms | ~450 ms | tool log |
| Middleware | `intake_open` | Result payload | ≤ 1 MB | 3 × 180 KB × 1.33 = 718 KB | tool log |
| Middleware | `donation_create` | p95 | ≤ 50 ms | ~20 ms | tool log |
| Middleware | `donation_report` | PDF packet p95 | ≤ 2,000 ms | ~800 ms | tool log |
| AI | Host, Sonnet low | End-to-end per log | ≤ 30 s | 1,500 + 1,000 ÷ 60 × 1,000 = 18.2 s | timestamps |
| AI | Host, Haiku low | End-to-end per log | ≤ 30 s | 800 + 1,000 ÷ 120 × 1,000 = 9.1 s | timestamps |
| Infrastructure | Node process | Peak RSS | ≤ 256 MB | ~200 MB | `/usr/bin/time -l` |

All "Est." values are estimates until measured.

## Launch plan

| Milestone | Done when |
|---|---|
| Contract and fixtures | Registry in place, four tools return fixture data, CLI runs, Inspector lists the tools |
| Real back-end | SQLite, guide JSON, 8283 grouping and the PDF work; evals meet the bar |
| v0.1 | README demo, npm, `.mcpb` release, MCP Registry listing |
| Launch push | Timed to tax season |

**Repo hygiene:** this repo is public. No real receipts, account details or donation records go in it. Fixtures are synthetic.

## Sources

- [IRS Form 8283](https://www.irs.gov/pub/irs-pdf/f8283.pdf) and [instructions](https://www.irs.gov/instructions/i8283)
- [IRS Publication 561, Determining the Value of Donated Property](https://www.irs.gov/publications/p561)
- [Example regional donation value guide (PDF)](https://www.goodwillgreatermc.org/docs/default-source/donations/goodwill_donated_value_guide-20231013.pdf)

Not tax or legal advice.
