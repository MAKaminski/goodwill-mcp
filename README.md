<p align="center">
  <img src="assets/banner.svg" alt="goodwill-mcp: receipt and photos in, logged donation and Form 8283 rows out" width="100%">
</p>

<p align="center">
  <a href="https://github.com/MAKaminski/goodwill-mcp/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/MAKaminski/goodwill-mcp?color=e0a526&label=release"></a>
  <a href="https://github.com/MAKaminski/goodwill-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MAKaminski/goodwill-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-2f6f57">
  <img alt="MCP stdio" src="https://img.shields.io/badge/MCP-stdio-10231c">
  <img alt="node 22.13 or newer" src="https://img.shields.io/badge/node-22.13%2B-2f6f57">
</p>

# goodwill-mcp

**Take a photo of your donation receipt and what you gave. Tell Claude "log my drop-off." Done.**

`goodwill-mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io) server that turns thrift-store donations into a clean, tax-ready ledger. Claude reads your photos. The server values each item from a published thrift-shop price guide, stores everything in one SQLite file on your machine, and produces your year-end Form 8283 rows.

> **Not affiliated.** This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Goodwill Industries International or any regional Goodwill organization. "Goodwill" is their trademark, used here only to describe the receipts this tool works with.

## Install

**Claude Desktop (one click).** Download [`goodwill-mcp.mcpb`](https://github.com/MAKaminski/goodwill-mcp/releases/latest) from the latest release and double-click it. Pick your inbox folder when asked.

**Claude Code.** (npm package publishing shortly; until then use *From source* below.)

```bash
claude mcp add goodwill -- npx -y goodwill-mcp server start
```

**Any MCP client** (Claude Desktop config, Cursor, others), once the npm package is live:

```json
{ "mcpServers": { "goodwill": { "command": "npx", "args": ["-y", "goodwill-mcp", "server", "start"] } } }
```

**From source.**

```bash
git clone https://github.com/MAKaminski/goodwill-mcp && cd goodwill-mcp
npm install && npm run build && npm test
claude mcp add goodwill -- node "$PWD/dist/cli.js" server start
```

Requires Node 22.13 or newer.

## Use it

1. Drop the receipt photo and item photos in `~/Donations/inbox`. Put "receipt" in the receipt's filename.
2. In Claude: **"Log my Goodwill drop-off."** (or run the `log_donation` prompt).
3. At tax time: **"Get my 2026 donations ready for taxes."**

iPhone photos must be JPEG: Settings > Camera > Formats > Most Compatible.

## What it looks like

Real output from the CLI (sample data):

```text
$ goodwill-mcp donation report --year 2026
DATE        STORE              ITEMS  FMV          RECEIPT
2026-03-14  Store #0412           12      $106.00  paper
2026-11-07  Store #0412          450    $2,250.00  paper
------------------------------------------------------------
2026        2 donations · $2,356.00 FMV
clothing    $2,356.00 of $5,000.00 appraisal line
· Noncash total $2,356.00 is over $500: file Form 8283 Section A.

$ goodwill-mcp donation report --year 2026 --format form8283
Form 8283 Section A · 2026 · required
- clothing: 462 items (women's blouses, men's jeans, women's clothing), good used condition or better
    (a) Goodwill (d) Various (e) Various (f) Purchase (g) MISSING (h) $2,356.00 (i) Thrift shop value
! Column (g) cost basis is missing on 1 line(s) over $500. Add cost_basis with donation_update, or a reasonable-cause statement.
```

## The four tools

| Tool | What it does |
|---|---|
| `intake_open` | Reads receipt and item photos from your inbox folder, resizes them, and hands them to Claude |
| `donation_create` | Validates Claude's item list, prices each item from the guide, saves the donation, archives the photos |
| `donation_update` | Corrects or voids a donation, with an append-only audit trail |
| `donation_report` | Year totals, CSV, Form 8283 Section A rows, and paste-ready text for a charity's donor portal |

Every tool is also a CLI command (`goodwill-mcp <noun> <verb>`, plus `--json`), generated from one registry. `goodwill-mcp valuation show` prints the price guide.

Prices come from the ranges Goodwill Industries International publishes for items commonly sold in its stores ([source](https://www.ocgoodwill.org/wp-content/uploads/2024/01/Valuation-Guide-2023.pdf)), in [`guides/goodwill.json`](guides/goodwill.json). Regional Goodwills publish their own; swap in yours if it differs. Items outside the guide take a `unit_value` you set.

## What it checks for you

| Rule | What the tool does |
|---|---|
| Noncash total over **$500** for the year | Flags that Form 8283 Section A is required |
| A group of similar items (all clothing, for example) over **$5,000** for the year | Warns before you cross it: that needs a qualified appraisal |
| Any single donation of **$250 or more** | Requires the receipt to be archived |
| Items below **good used condition** | Leaves them out, with a note |
| Form 8283 columns | Records description, condition, date, how acquired, cost basis, fair market value and method ("thrift shop value") |

It logs **fair market value donated**, not tax saved. Noncash donations are deductible only if you itemize. This tool is not tax advice.

## Why local

- One process, one SQLite file, zero services to run.
- Your receipts and photos never leave your machine, apart from the images Claude already sees in your chat.
- The server makes no model calls. Running it costs $0.

## Docs

- [Proposal](docs/PROPOSAL.md): scope, tool contracts, cost and performance budgets
- [Architecture](ARCHITECTURE.md): sequence diagram, five-layer architecture, ERD, command tree

## Roadmap

- [x] v0.1: four tools, CLI, clothing price guide, Form 8283 rows, donor-portal text, `.mcpb` bundle
- [ ] PDF packet with receipt images
- [ ] Household, furniture and electronics price ranges
- [ ] MCP Registry listing
- [ ] More organization profiles (one JSON file each)
- [ ] v1.1: hosted option for phone-only use

## License

[MIT](LICENSE)
