<p align="center">
  <img src="assets/banner.svg" alt="goodwill-mcp: receipt and photos in, logged donation and Form 8283 rows out" width="100%">
</p>

<p align="center">
  <img alt="status design" src="https://img.shields.io/badge/status-design%20%E2%86%92%20v0.1-e0a526">
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-2f6f57">
  <img alt="MCP: stdio" src="https://img.shields.io/badge/MCP-stdio-10231c">
  <img alt="node 22.13 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-2f6f57">
</p>

# goodwill-mcp

**Take a photo of your donation receipt and what you gave. Tell Claude "log my drop-off." Done.**

`goodwill-mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io) server that turns thrift-store donations into a clean, tax-ready ledger. Claude reads your photos. The server values each item from a published thrift-shop price guide, stores everything in one SQLite file on your machine, and produces your year-end Form 8283 rows.

> **Status:** design complete, v0.1 in progress. The commands below describe the v0.1 contract. See the [proposal](docs/PROPOSAL.md) and [architecture](ARCHITECTURE.md).

> **Not affiliated.** This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Goodwill Industries International or any regional Goodwill organization. "Goodwill" is their trademark, used here only to describe the receipts this tool works with.

## Launch

```bash
# Claude Code
claude mcp add goodwill -- npx -y goodwill-mcp

# CLI
npx goodwill-mcp donation report --year 2026

# Development, from a clean clone
pnpm i && pnpm dev        # MCP Inspector at http://localhost:6274
```

Claude Desktop config:

```json
{ "mcpServers": { "goodwill": { "command": "npx", "args": ["-y", "goodwill-mcp"] } } }
```

## What it looks like

```text
You     Log my Goodwill drop-off.
Claude  ▸ intake_open        receipt + 2 item photos · 0.5 s
        ▸ donation_create    9 items · thrift shop value
        Logged 2026-11-10 · receipt archived
        9 items · $86.00 FMV · 2026 total $150.00
        1 item skipped: "stained rug" is below good used condition
        Form 8283: $350.00 until it's required
```

```text
$ goodwill-mcp donation report --year 2026
DATE        STORE         ITEMS  FMV      RECEIPT
2026-03-14  Store #0412      12   $64.00  archived
2026-11-10  Store #0412       9   $86.00  archived
--------------------------------------------------
2026        2 donations · 21 items · $150.00 FMV
Form 8283   not required yet ($500 line) · $350.00 headroom
Clothing    $150.00 of $5,000 appraisal line
```

Values above are illustrative.

## The four tools

| Tool | What it does |
|---|---|
| `intake_open` | Reads receipt and item photos from your inbox folder, resizes them, and hands them to Claude |
| `donation_create` | Validates Claude's item list, prices each item from the guide, saves the donation, archives the photos |
| `donation_update` | Corrects or voids a donation, with an append-only audit trail |
| `donation_report` | Year totals, Form 8283 Section A rows, CSV, and a PDF packet with your receipts |

Every tool is also a CLI command (`goodwill-mcp <noun> <verb>`), generated from one registry.

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

- [Proposal](docs/PROPOSAL.md): scope, tool contracts, launch plan, cost and performance budgets
- [Architecture](ARCHITECTURE.md): sequence diagram, five-layer architecture, ERD, command tree

## Roadmap

- [ ] v0.1: four tools, CLI, price guide, Form 8283 export
- [ ] `.mcpb` one-click bundle and MCP Registry listing
- [ ] More organization profiles (one JSON file each)
- [ ] v1.1: hosted option for phone-only use

## License

[MIT](LICENSE)
