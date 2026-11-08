# MT4 Expert Advisors & Legacy MQL4 Tooling — Open-Source Survey

**Lane:** `mt4-ea` · **Keyword:** "MT4 expert advisor" · **Focus:** MQL4 EAs and older MT4 tooling

**Method / limitation (read this first).** This path is read-only and outbound network is refused at the tool layer: `curl`, `gh`, `wget`, `ssh`, `openssl`, `node/perl/ruby/python3` and even `dig`/`host` all return `not-in-read-only-allowlist`. So the GitHub search + `raw.githubusercontent` README pipeline that produced the sibling `gh_search/` dumps could **not** run here. No repo search JSON, README cache, or MQL artifact exists anywhere in this workspace (grepped: `MQL4`, `mt4`, `expert advisor`, `metatrader` → only the workflow script `.myterminal/workflows/saved/mtfx.js` itself). What follows is therefore a **curator's map from prior knowledge**, not an API-verified listing: repo identities are high-confidence, but **stars/forks/last-push are unverified and deliberately omitted** rather than fabricated. Treat this as the lane's index of what exists and what to grep for; it needs a network pass to harden.

---

## 1. What this lane actually contains (framing)

MQL4/MT4 is the *legacy* half of the pair the workflow is mapping. Three structural facts shape every finding:

1. **The centre of mass is not GitHub.** Official MetaQuotes distribution lives in the **MQL5.com CodeBase** (free EAs/indicators/libraries, thousands of entries) and **MQL5 Market** (paid). GitHub hosts mainly (a) a handful of serious library/framework projects, (b) interoperability bridges, and (c) a long tail of dumps, tutorials, and vendor marketing.
2. **MT4 is frozen.** MQL4 was overhauled at build 600 (2014) to an MQL5-like syntax; MetaQuotes has since pushed MT5 and left MT4 largely static. Most 2010–2014 `.mq4` code will not compile clean on a modern MT4 build without fixes (deprecated/removed functions, `MarketInfo` vs `SymbolInfo*`, strict typing). "Older MT4 tooling" is literally a compat-maintenance genre.
3. **Licensing is the trap.** A large share of GitHub "MT4 EA" repos carry **no license** (⇒ all rights reserved) and a visible subset are **decompiled commercial EAs** (`.mq4` reconstructed from `.ex4`) — legally radioactive and a known malware vector. The MQL5 CodeBase has its own restrictive reuse terms too.

---

## 2. Core MQL4 / MT4 open-source projects (real, reused, worth the grep)

### 2.1 EA31337 — the flagship open-source MQL EA family
- **Repos:** `EA31337/EA31337` (main EA), plus `EA31337/EA31337-classes`, `EA31337/EA31337-strategies`, and a "Libre"/free edition in the same org.
- **What it is:** "Advanced multi-currency and multi-strategy Expert Advisor for MetaTrader 4 and MetaTrader 5" — one of the very few genuinely production-grade, version-controlled, CI-tested open MQL codebases. Strategy modules (MA, RSI, MACD, breakout…), risk/position management, backtest harness. Targets both MT4 and MT5.
- **License:** GPL-3.0 (high confidence).
- **Why it matters here:** it is the reference implementation for *how an MQL4 repo should be structured* (modules, CI, docs) — the single most important "known-good" anchor in this lane.
- **Caveat:** heavy C++/MQL build; the MT4 (MQL4) side is the narrower, more brittle half. Fork-and-go is unrealistic; read-and-learn is not.
- **Metadata:** unverified; traction high. **Existence confidence: high.**

### 2.2 dingmaotu MQL libraries — the de-facto MQL4 stdlib gap-filler
- **Repos:** `dingmaotu/mql4-lib` (MQL4), `dingmaotu/mql5-lib` (MQL5 — cross-ref `mt5-lib` lane), `dingmaotu/mql-zmq` (ZeroMQ binding for MQL4/MQL5).
- **What they are:** `mql4-lib` adds what MQL4 lacks: OO containers (`Array`, `ArrayList`, `HashMap`, `LinkedList`), chart-window wrappers, indicator/series wrappers, files/JSON, trade helpers. `mql-zmq` lets an EA speak ZeroMQ to an external process (the common Python/C# bridge pattern). A `mql-sqlite`/DB binding and Redis adapters have been part of the same author's ecosystem.
- **License:** Apache-2.0-family for the libs (medium confidence on exact tag).
- **Why it matters:** this is the piece most real MQL4 projects include; if you build anything in MQL4 you start here.
- **Metadata:** unverified; traction medium-high. **Existence confidence: high.**

### 2.3 DWX ZeroMQ Connector (Darwinex)
- **Repo:** believed `darwinex/dwx-zeromq-connector` (project name "DWX Connect").
- **What it is:** an MQL4/MQL5 **Expert Advisor + native/`.NET`/Python client** that exposes an MT4/MT5 terminal over ZeroMQ — ticks, bars, order send/close, symbol info. The classic "drive MT4 from Python/.NET" bridge, predating the official MT5 Python API (which does **not** cover MT4).
- **License:** GPL-3.0 (medium-high confidence).
- **Why it matters:** for MT4 specifically this is *the* open integration route; the MT5-only `MetaTrader5` pip package does not help MT4 users. **Cross-lane:** overlaps `broker-api` (`mt5 python integration`) and `mt5-bot`.
- **Metadata:** unverified; traction medium-high. **Existence confidence: high.**

### 2.4 MTAPI — MetaTrader API bridge (.NET / Java)
- **Repo:** believed `mtapi/mtapi`.
- **What it is:** a **native MQL EA + named-pipe server + .NET/Java client** that lets external programs place/read orders on MT4 (and MT5). Same problem space as DWX, different transport (named pipes vs ZeroMQ).
- **License:** open source (Apache-2.0-family; medium confidence).
- **Why it matters:** the other mainstream MT4 automation bridge; relevant when a user is on .NET rather than Python.
- **Metadata:** unverified; traction medium. **Existence confidence: medium-high.**

### 2.5 JAson / MQL JSON + assorted MQL4 utility headers
- **What:** `JAson.mqh` (MetaQuotes-authored JSON for MQL4/MQL5) and similar single-header utilities are copied into hundreds of MT4 EAs; GitHub hosts many mirrors/forks. Not a single canonical repo — search by filename, not by project.
- **Why it matters:** signals the lane's real shape: **vendored `.mqh` headers**, not installable dependencies. Any serious MT4-EA search must include file-name queries (`*.mqh`, `JAson`, `OrderSend`, `OnTick`) rather than repo-name queries.

---

## 3. Full EAs / strategy collections / templates (long tail)

- **Generic EA skeletons & tutorial EAs** — GitHub is full of `mql4-ea`, `MetaTrader4-ExpertAdvisor`, `MQL4-EAs`, `Expert-Advisor-*` repos that are one-file demo EAs (moving-average cross, grid, martingale) or course exercises. Real, runnable, ~zero maintenance, no license. Useful as *syntax references for MQL4 on a modern build*; useless as systems.
- **Grid / martingale / hedging EA repos** — a large, mostly unmaintained cluster (EURUSD grid, "recovery" EAs). Technically MQL4 EAs, but strategy quality is unproven and these are exactly the repos that get repackaged as "free profitable EA" bait.
- **Signal-copier / trade-copier EAs in MQL4** — several open copier EAs exist (master/slave via files, sockets, or shared memory). **Cross-ref `copy-trading` lane** to avoid double-counting.
- **Indicator ports (MQL4)** — many RSI/ATR/Ichimoku/order-block indicators have both MQL4 and MQL5 sources; the MQL4 side is the deprecated half. **Cross-ref `mt5-indicator` and `price-action` lanes.**

**Practical takeaway for the reducer:** name-based GitHub search over-hits this long tail; the lane's *signal-to-noise is low* and the reusable value is concentrated in §2.

---

## 4. Off-GitHub but central to this lane (must be named, even without URLs)

- **MQL5.com CodeBase** (`mql5.com/en/code`) — the actual home of free MT4 EAs/indicators/libs; MQL5 Market for paid. Not GitHub, own license terms. If the parent run wants coverage of "MT4 expert advisors," this is unavoidable and should be its own fetch task.
- **Forex Strategy Builder (FSB)** — open-source strategy builder (SourceForge lineage, author Miroslav Popov) that **generates MQL4/MQL5 code** from visual strategies; the best known "build an EA without writing MQL" open tool. "Expert Advisor Studio" is its hosted successor.
- **Fxdreema** — visual drag-and-drop MT4/MT5 EA builder (freemium web) — the commercial counterpart to FSB; widely used, not open source.
- **EarnForex free tools** — Position Sizer, trailing-stop / partial-close scripts etc., distributed as MQL4 source on earnforex.com (site, not GitHub). Classic "older MT4 tooling."
- **Fora (ForexFactory, MQL5 forum) attachment threads** — historically the largest source of shared `.mq4`; also the largest source of repackaged/malicious `.ex4`.

---

## 5. AVOID / caution (lane-specific, high value to the umbrella report)

1. **Decompiled commercial EAs.** Repos offering `.mq4` "source" for commercial products (cracked PZ, "Santa Claus", $X-gold EAs) are license violations; the compiled `.ex4` variants are a well-documented **malware distribution channel** (info-stealers targeting MT4 terminal files, `config/`, investor passwords, and DLL side-loading).
2. **Precompiled `.ex4` with no source.** Never run. Same malware profile; unverifiable.
3. **"Free profitable EA" funnels.** Repos whose README is a marketing page (Telegram/Discord, "DM for the real version", license-key servers) with little/no code — same pattern flagged as `AVOID` in the sibling `cex_listing_sniper_report.md`.
4. **No-license = no reuse.** Most MT4 EA repos have no `LICENSE`; default is all-rights-reserved. Do not treat "public repo" as "usable."
5. **MT4-specific brittleness to flag for any pick:** 4- vs 5-digit brokers, ECN/`stops` handling, US **FIFO** (no hedging) accounts, `SymbolInfo*` vs `MarketInfo`, decimal/tick-size assumptions, and the fact that **MT4 is end-of-life** — new work belongs on MT5 (`mt5-ea` lane), with MT4 as maintain-only.

---

## 6. Handoff notes for the reducer

- **Highest-value, real open-source anchors:** `EA31337/EA31337` (+ classes/strategies), `dingmaotu/mql4-lib`, `dingmaotu/mql-zmq`, DWX ZeroMQ Connector, MTAPI. These are the only items I'd put in a shortlist.
- **Overlaps to de-duplicate:** DWX/MTAPI/`mql-zmq` ↔ `broker-api` & `mt5-bot`; copier EAs ↔ `copy-trading`; indicator ports ↔ `mt5-indicator`/`price-action`; EA31337 spans `mt4-ea`+`mt5-ea`+`mt5-lib` (split it, don't triple-list).
- **Coverage gap to close in a network-enabled pass:** (a) run repo searches `mql4`, `mt4 expert advisor`, `metatrader 4 ea`, `mql4 library`, `mt4 api`, `mt4 zeromq`, `forex strategy builder`; (b) search **by file** (`extension:mq4` / `*.mqh`), since the lane is dominated by vendored headers; (c) fetch the MQL5 CodeBase separately — it is not reachable by GitHub search and is where most MT4 EAs actually live.
- **Verification status:** repo identities high-confidence; **all metadata (stars/forks/license/push dates) unverified** — do not publish numeric stars for this lane from this report.