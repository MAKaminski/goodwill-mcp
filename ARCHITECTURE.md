# Architecture

The same node names appear in every diagram, the command registry and the code. Each hop on the user path shows its p95 budget.

## Features and what they use

| Feature | Components | Tables owned | Models called |
|---|---|---|---|
| Log a donation | `intake_open`, `donation_create`, registry, validators, valuation rules | `intake`, `attachment`, `donation`, `donation_item` | Host model for photo extraction (Sonnet low / Haiku low) |
| Correct a donation | `donation_update` | `revision` | None |
| Year-end export | `donation_report` | none (reads) | None |
| Price guide | guide loader | `org`, `valuation_guide`, `valuation_rate` | None |

## Layers: state and processes

| Layer | State (how it exists) | Process: input → processing → output |
|---|---|---|
| Front-end | Chat surface in the host; `goodwill-mcp` CLI | Request or command → registry lookup → table or JSON |
| Middleware | `commands.ts` registry; MCP stdio server; Zod validators | Tool call → validate → run command → structured result |
| Middleware — AI | Host model; `log_donation` prompt; valuation rules | Photos → host extracts `DonationDraft` → rules price and flag it |
| Back-end | `ledger.db` (SQLite); `archive/` images; `guides/*.json` | Draft → insert rows + revision → donation record |
| Infrastructure | One Node process per host session; GitHub Actions | Release tag → test → npm + `.mcpb` + registry entry |

## Sequence: log a donation, then year-end export

```mermaid
sequenceDiagram
  actor U as Donor
  participant FS as Inbox and archive (filesystem)
  participant H as Claude host (Sonnet low)
  participant S as goodwill-mcp server (rules)
  participant DB as ledger.db (SQLite)
  U->>FS: Drop receipt + item photos in inbox folder
  U->>H: Log my Goodwill drop-off
  H->>S: intake_open (p95 600ms)
  S->>FS: read + resize to 1568px long edge (p95 450ms)
  S-->>H: intake_id + 3 image blocks
  H->>H: extract store, date, items, condition (est 18s e2e)
  H->>S: donation_create(intake_id, items) (p95 50ms)
  S->>DB: valuation_rate lookup (rules, under 1ms)
  S->>DB: insert donation, items, revision
  S->>FS: move images to archive by sha256
  S-->>H: donation + YTD total + threshold flags
  H-->>U: Logged, YTD total, Form 8283 status
  U->>H: Get the year ready for taxes
  H->>S: donation_report(year, format 8283) (p95 300ms)
  S->>DB: aggregate similar items (rules)
  S-->>H: Section A rows + CSV + PDF packet paths
  H-->>U: totals + files
```

## Architecture: five layers

```mermaid
flowchart LR
  subgraph FE[Front-end]
    chat[Claude chat surface]
    cli[goodwill-mcp CLI]
  end
  subgraph MW[Middleware]
    reg[commands.ts registry]
    mcp["MCP stdio server - 4 tools"]
    val[Zod validators]
  end
  subgraph AI[Middleware - AI]
    host["Host vision - Sonnet low / Haiku low"]
    oll["Ollama qwen2.5vl 7B Q4 ~6 GB - optional CLI path"]
    rules["valuation lookup - rules Tier 0"]
  end
  subgraph BE[Back-end]
    db[("ledger.db SQLite")]
    files[("archive/ images by sha256")]
    guide[("guides/goodwill-2026.json")]
  end
  subgraph INF[Infrastructure]
    proc["node process per host ~200 MB peak"]
    ci["GitHub Actions - npm, MCP Registry, .mcpb"]
  end
  chat --> host
  host --> mcp
  cli --> reg
  mcp --> reg
  reg --> val
  val --> rules
  rules --> guide
  reg --> db
  reg --> files
  cli -. optional .-> oll
  proc --- mcp
  ci --> proc
```

## ERD: the full back-end

Every table has a foreign key. A new charity is one `org` row plus one `valuation_guide`.

```mermaid
erDiagram
  ORG ||--o{ VALUATION_GUIDE : publishes
  VALUATION_GUIDE ||--o{ VALUATION_RATE : contains
  ORG ||--o{ DONATION : receives
  INTAKE ||--o| DONATION : becomes
  INTAKE ||--o{ ATTACHMENT : holds
  DONATION ||--o{ DONATION_ITEM : has
  VALUATION_RATE ||--o{ DONATION_ITEM : prices
  DONATION ||--o{ REVISION : audits
  ORG {
    text id PK
    text slug
    text name
    text ein
  }
  VALUATION_GUIDE {
    text id PK
    text org_id FK
    text version
    int tax_year
    text source_url
  }
  VALUATION_RATE {
    text id PK
    text guide_id FK
    text category
    text item
    int low_cents
    int high_cents
  }
  INTAKE {
    text id PK
    text opened_at
    text status
  }
  ATTACHMENT {
    text sha256 PK
    text intake_id FK
    text kind
    text path
    int bytes
  }
  DONATION {
    text id PK
    text org_id FK
    text intake_id FK
    text donated_at
    text store_name
    text receipt_number
    text valuation_basis
    int total_cents
    text status
  }
  DONATION_ITEM {
    text id PK
    text donation_id FK
    text rate_id FK
    text description
    int qty
    text condition
    int unit_cents
    text acquired
    int cost_basis_cents
    text override_reason
    text photo_sha256
  }
  REVISION {
    text id PK
    text donation_id FK
    text at
    text patch_json
    text reason
  }
```

## Command tree (CLI = MCP, one registry)

```mermaid
flowchart TD
  t[goodwill-mcp] --> i[intake]
  t --> d[donation]
  t --> v[valuation]
  t --> s[server]
  t --> e[eval]
  i --> io["open (MCP: intake_open)"]
  d --> dc["create (MCP: donation_create)"]
  d --> du["update (MCP: donation_update)"]
  d --> dr["report (MCP: donation_report)"]
  v --> vs["show (CLI only)"]
  s --> ss["start (CLI only)"]
  e --> er["run (CLI only)"]
```

## Directory

```text
goodwill-mcp/
  src/commands.ts        one registry: MCP tools, CLI commands, docs table
  src/server.ts          MCP stdio server
  src/cli.ts             CLI entry
  src/rules/             valuation lookup, thresholds, Form 8283 grouping
  src/db/                migrations and queries
  guides/                versioned price-guide JSON per organization
  fixtures/              synthetic receipts and photos
  docs/PROPOSAL.md
  ARCHITECTURE.md
```

## Pattern table

| Pattern | Used for | Rule |
|---|---|---|
| Registry entry | Every tool and command | One entry yields the MCP tool, CLI command and docs row |
| Rule function | Valuation, thresholds, grouping | Pure function, no model call |
| Append-only revision | Every change to a donation | Never edit history in place |
| Versioned JSON guide | Each organization's price list | New charity is a new file, not new code |
