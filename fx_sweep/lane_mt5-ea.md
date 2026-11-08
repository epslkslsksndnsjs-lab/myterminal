# MT5 Expert Advisors — MQL5 EA Robots & Signal Copiers
Lane: `mt5-ea` · keyword "MT5 expert advisor" · focus: MQL5 EA trading robots and signal copiers. Run `wf_71a518c957daaf7c` (script `.myterminal/workflows/saved/mtfx.js`), 2026-10-04.

## Method & hard caveat (read first)
This path is **read-only and network-blocked at the tool layer**: `curl`, `wget`, `gh`, `git ls-remote`, `nc`, `openssl`, and `python3`/`node -e` are all refused (`not-in-read-only-allowlist`), and the allowlist in `src/workflows/tool-command.ts` confirms it (only `ls/cat/grep/jq/git status|log|…`-class reads run). A repo-wide grep for `mql5|metatrader|mt5|expert advisor|forex` finds **no MT5/forex corpus on disk** — only the workflow script itself and the CEX-lane dumps (`gh_search/`, `verify2/`). So unlike the sibling `cex_listing_sniper_report.md`, this lane **could not** be populated from GitHub Search/Repo API responses.

What follows is a **curator's map from prior knowledge**, not an API-verified repo survey. Repo identities are tagged with confidence; **stars/forks/license/last-push are deliberately omitted rather than fabricated**. Structural findings and the risk section are the parts I'd stand behind. The sibling lanes `mt4-ea` and `mt5-bot` hit the same wall and returned the same shape of result.

---

## 1. How this lane is shaped (framing)
Four structural facts govern every MT5-EA finding:

1. **The centre of mass is not GitHub.** Free EAs/indicators/libraries live in the **MQL5.com CodeBase** (`mql5.com/en/code`); paid ones in the **MQL5 Market** (MetaQuotes takes ~30%). GitHub hosts (a) a few serious framework/library projects, (b) interop bridges, and (c) a long tail of tutorials, dumps, and vendor marketing. Any honest "MT5 EA survey" must name the CodeBase/Market as the real shelf.
2. **MT5/MQL5 is the modern, supported half.** MQL5 is C++-like, object-oriented, event-driven (`OnInit/OnTick/OnTimer/OnTrade/OnTradeTransaction/OnChartEvent/OnBookEvent`), with hedging *and* netting accounts, a real-tick Strategy Tester, and multi-threaded/cloud optimization. New EA work belongs here; MT4 is maintain-only (see `mt4-ea` lane).
3. **There is no open server API.** MetaQuotes ships no REST/socket API for MT5. Every external actor talks through **(a)** the official `MetaTrader5` Python package (Windows-only, closed-source freeware, drives a *running terminal* over local IPC) or **(b)** an in-terminal EA acting as an RPC/bridge server. This is why the "robot" and "copier" halves of this lane both collapse onto bridges.
4. **"Signal copier" is three different products** and the lane conflates them: **broker/server copy** (MQL5 Signals — closed, but the free default), **MT5↔MT5 trade-copier EAs** (master/slave over globals/files/pipes/sockets), and **MT5↔external-process bridges** (ZeroMQ/REST/Redis/MQTT). Only the last is where genuinely reusable open source lives — and it overlaps `broker-api`, `copy-trading`, and `tradingview`.

---

## 2. Core open MT5 EA projects (real, reused — the shortlist)

### 2.1 EA31337 — the flagship open MQL EA family *(existence: high)*
- **Repos:** `EA31337/EA31337` (main EA), `EA31337/EA31337-classes`, `EA31337/EA31337-strategies`.
- **What:** "Advanced multi-currency, multi-strategy Expert Advisor for MetaTrader 4 and MetaTrader 5" — the rare production-grade, version-controlled, CI-tested open MQL codebase. Modular strategies (MA, RSI, MACD, breakout…), risk/position management, backtest harness. GPL-3.0 (high confidence).
- **Why it matters here:** the reference implementation for *how an MQL EA repo should be built*; the one "known-good" anchor the whole lane hangs on. **Cross-lane:** spans `mt5-ea` + `mt5-lib` + `mt4-ea` — list once, not three times.
- **Caveat:** heavy build; fork-and-go unrealistic, read-and-learn is not.

### 2.2 `MetaTrader5` Python package + `mt5linux` — the default MT5 automation substrate *(high)*
- **`MetaTrader5`** (PyPI, MetaQuotes) — free, **closed**, **Windows-only**; `initialize()`, `symbol_info_tick()`, `copy_rates_from_pos()`, `order_send()`. Every "MT5 bot" README depends on it. Not a bot — the substrate.
- **`mt5linux`** (PyPI) — RPyC shim to run that package from Linux against a Wine MT5. Verify owner/maintenance.
- **Why it matters:** it is the *de-facto* MT5 EA-driver route and the main competitor to bridges (§2.4). **Cross-lane:** `broker-api`.

### 2.3 dingmaotu MQL5 libraries — the stdlib gap-filler *(high)*
- **Repos:** `dingmaotu/mql5-lib` (Apache-2.0-family), `dingmaotu/mql-zmq`, plus `mql-redis`, `mql-sqlite3`.
- **What:** `mql5-lib` adds what MQL5 keeps thin — OO containers (`Array`, `HashMap`, `LinkedList`), chart/series wrappers, JSON, file/trade helpers. `mql-zmq` lets an **EA speak ZeroMQ** to an external process. **Cross-lane:** `mt5-lib` owns the library inventory; this lane only needs it as the building block under bridges.

### 2.4 Interop bridges that drive MT5 EAs *(existence: high; metadata medium)*
- **`darwinex/dwx-zeromq-connector`** ("DWX Connect") — EA + native/.NET/Python client exposing MT5 over **ZeroMQ** (ticks, bars, order send/close). The classic headless-control route; predates the official Python API. GPL/MIT-family (verify tag). **Cross-lane:** `broker-api`, `mt5-bot`.
- **`vdemydiuk/mtapi`** (MtApi / MtApi5) — native MQL **EA + named-pipe server + .NET/Java client**; REST/JSON façade. Apache-family (medium). Low activity. **Cross-lane:** `broker-api`.

### 2.5 The MQL5 Standard Library + Wizard — the "open EA generator" most people miss *(high)*
- Ships **inside the terminal** under `Include/`: `Trade\Trade.mqh` (`CTrade`, `CPositionInfo`, `CSymbolInfo`, `CAccountInfo`, `COrderInfo`, `CDealInfo`), `Expert\` (`CExpert` framework, `CSignal*` classes), `Indicators\`, `Arrays\`, `Files\`, `Math\`.
- **MQL5 Wizard** generates a complete EA from selected signal + money-management + trailing modules → an *open, built-in* EA factory with no third-party code. For a solo user this is the lowest-risk starting point in the entire lane.
- **Cross-lane:** the `mt5-lib` lane should own the full inventory; I reference it because it is the main "real EA" source people overlook.

### 2.6 Author-distributed MQL5 frameworks (off-GitHub, must be named) *(medium-high)*
- **`fxsaber`'s "Generic" framework** (MQL5 forum/CodeBase) — the influential multi-symbol, multi-timeframe EA architecture copied across the ecosystem. Distributed as forum source, not a GitHub project.
- **`JAson.mqh`** (MetaQuotes JSON) and similar vendored `.mqh` headers — the lane is dominated by *copied single headers*, so file-name search (`*.mqh`, `CTrade`, `OnTradeTransaction`) beats repo-name search.

---

## 3. Signal copiers & copy bridges (the lane's second focus)

| Kind | Representative | Open? | Notes |
|---|---|---|---|
| Broker/server copy | **MQL5 Signals** (`mql5.com/en/signals`) | Closed | Built into MT5; the free default most users actually use; broker-hosted, exposes subscriber history. |
| MT5↔MT5 EA copier | **FX Blue Personal Trade Copier** | Free, closed | The de-facto free copier answer (MT4/MT5). |
| MT5↔MT5 EA copier | EarnForex Trade Copier, Local Trade Copier, TSCopyTrader, CopyMaster | Paid/closed | Commercial tier. |
| External bridge | **DWX ZeroMQ connector** (§2.4) | Open | The right base for an *open* copier. |
| External bridge | `dingmaotu/mql-zmq`, `mql-redis` | Open | Block-level pieces for sockets/queues. |
| Telegram→MT5 "signal copier" EAs | small `python-telegram-bot`/`telethon` + `order_send()` scripts | Open, unpolished | **Cross-lane:** `mt5-bot` owns this; do not double-count. |

**Structural finding:** robust open *MT5↔MT5* copiers are effectively absent — the good ones are free-but-closed (FX Blue) or paid, and the open ones are fragile (global-variable/file polling, no symbol/volume reconciliation, no slippage/fill handling). Anything an open EA copier must get right: symbol suffixes/prefixes, volume scaling by equity, **hedging vs netting** account mode, partial fills, `OnTradeTransaction`-based deal detection, and broker-side algo-trading/FIFO restrictions. That shortlist *is* the lane's gap statement.

---

## 4. Adjacent builders (generate MQL5, not hand-written EAs)
- **Forex Strategy Builder (FSB)** — open-source (SourceForge lineage, M. Popov); visually builds a strategy and **emits MQL4/MQL5 code**. Its hosted successor is *Expert Advisor Studio*. The best known "make an EA without writing MQL" open tool.
- **MQL5 Wizard + Standard Library** (§2.5) — the built-in equivalent.
- **Fxdreema / EA Builder** — commercial drag-and-drop counterparts (not open).
- **EarnForex free tools** (Position Sizer, trailing-stop/partial-close scripts) — MQL5 source on earnforex.com, not GitHub. Classic "must-have" utility shelf.

---

## 5. Commercial baseline to name honestly (so the "open source" gap is truthful)
MQL5 Market's top-selling EAs are closed and expensive and the market is rife with curve-fitted "holy grail" products (the *Waka Waka / Perceptrader / Gold Reaper / neural-hedge* class). Naming them matters because the honest finding is: **the market is big and closed, open-source MT5 EAs are thin, and the gap is quality not quantity.** Also note the *MQL5 Signals* rating system can be gamed with short-history, low-risk-then-martingale providers — the same trap as the closed EA shelf.

---

## 6. AVOID / risk flags (high value to the umbrella report)
1. **Decompiled commercial EAs** — `.mq5`/`.mq4` "source" reconstructed from `.ex5`/`.ex4` (cracked PZ, "Santa Claus", gold EAs). License-violating and a documented **malware channel** (info-stealers targeting MT5 terminal files, `config/`, investor passwords; DLL side-loading).
2. **Precompiled `.ex5` with no source** — never run; unverifiable.
3. **`curl | bash` "one-line installers"** and EA/DLL installers — top malware vector in MT4/MT5 repos.
4. **"Send your (investor) password"** tools — investor password leaks performance; **master** password = full account control. Signal-copier funnels asking for either are the classic drain pattern.
5. **"AI / quant MT5 EA" funnels** — keyword-stuffed README → paid Telegram; code never calls `order_send`/`OrderSend`. Same pattern as the CEX lane's `AVOID` list.
6. **No-license = no reuse** — most MT5 EA repos ship no `LICENSE` (default: all rights reserved). "Public repo" ≠ usable.
7. **Curve-fitting/backtest fakery** — 99%-win-rate tester screenshots with no walk-forward, tick-model caveats, or spread realism; use the Strategy Tester's real-tick mode and out-of-sample to falsify.

---

## 7. Handoff notes for the reducer
- **Shortlist (only items I'd promote):** `EA31337/EA31337` (+classes/strategies); `dingmaotu/mql5-lib` + `mql-zmq`; DWX ZeroMQ connector; `vdemydiuk/mtapi`; `MetaTrader5` Python package + `mt5linux`; the built-in **MQL5 Standard Library + Wizard**; **FSB** for codegen; **MQL5 CodeBase/Market** as the off-GitHub shelf.
- **De-duplicate:** DWX / mtapi / `mql-zmq` / `mt5linux` ↔ `broker-api` & `mt5-bot`; copier EAs ↔ `copy-trading`; indicator ports ↔ `mt5-indicator`/`price-action`; EA31337 ↔ `mt4-ea` + `mt5-lib` (split once). Telegram/Discord control is the `mt5-bot` lane's, not mine.
- **Coverage gap to close in a network-enabled pass:** run repo queries `mt5 expert advisor`, `mql5 ea`, `metatrader 5 ea`, `mt5 trade copier`, `mql5 signal copier`, `mt5 zmq`, `mt5 telegram signal`, `ea31337`; search **by file** (`extension:mq5`, `*.mqh`, `CTrade`, `OnTradeTransaction`) because the lane is vendored headers; and fetch **MQL5 CodeBase** separately — GitHub search cannot reach where most MT5 EAs actually live.
- **Verification status:** repo identities high-confidence; **all metadata (stars/forks/license/push) unverified — do not publish numeric stars for this lane from this report.**