# Lane mt5-lib — MQL5 libraries, wrappers & indicator collections
*Scope: reusable MQL5/MQL4 **code libraries** (`.mqh` includes / class frameworks), **wrappers/bindings** that reach outside the terminal, and **indicator/library collections**. Single EAs, individual indicator ports and the Python bridge are other lanes (mt5-ea / mt5-indicator / broker-api) and are only referenced here at the boundary.*

> **PROVENANCE — read first.** This path is a read-only workflow lane: the shell allowlist blocks `curl`, `wget`, `gh`, `python3`, `node -e`/`bun -e` (only `ls/cat/grep/find/git status|log|show/jq/…` run), so **no live GitHub API call was possible in this run**. Everything below is from domain knowledge; treat star figures as order-of-magnitude (`hundreds`), not measured numbers, and re-verify repo identity + license with a live search before publishing. No MQL5/forex dataset exists anywhere under this working dir — I checked the whole tree (`.scratch`, `gh_search`, `gem-research`, `verify2`, `.myterminal`) and the only hit is the workflow script `.myterminal/workflows/saved/mtfx.js` itself.

---

## 0. Why this lane does not look like the crypto lanes
MQL5 is a compiled, C++-like language with **no package manager** (no pip/npm). "Installing" a library means copying `.mqh` files into `MQL5/Include/` and `#include`-ing them. Consequences:

- The **real** "MQL5 libraries + indicator collections" are **not on GitHub** — they are (1) the **built-in Standard Library shipped in every terminal**, and (2) the **MQL5.com CodeBase/Articles**, a web collection of tens of thousands of free indicators/scripts/EAs.
- GitHub hosts a **thin but high-value layer** on top: OOP class frameworks, native-language bindings (ZeroMQ/SQLite/HTTP), and broker bridges. This is what a "mt5-lib" survey is actually about.
- Licensing is a minefield: bundled Standard Library and CodeBase items are **not OSI open source**, and a large share of GitHub MQL repos ship **no license at all** = "all rights reserved" despite visible source.

---

## 1. The two built-in decks (the genuine collections)

### 1a. MetaQuotes Standard Library — `MQL5/Include/*` (ships in-terminal, MQL5 + MQL4)
The default base every project extends. Not a GitHub repo; bundled with MetaEditor. Key families:
- **Trade**: `Trade\Trade.mqh` (`CTrade`), `PositionInfo`, `OrderInfo`, `SymbolInfo`, `AccountInfo`, `DealInfo`, `HistoryOrderInfo` — the standard order/account wrapper.
- **Expert framework**: `Expert.mqh` (`CExpert`), `Signal.mqh` (`CSignal`), `TrailingStop`, `Money` — the built-in EA skeleton people subclass.
- **Indicators (programmatic)**: `Indicators\` classes `CiMA, CiMACD, CiRSI, CiStochastic, CiBands, CiADX, CiATR, CiIchimoku, CiCCI, CiSAR, CiWPR, CiMFI, CiAO, CiOsMA, CiDeMarker, CiEnvelopes, CiForce, CiFractals, CiGator, CiMomentum, CiStdDev, CiBullsPower, CiBearsPower, CiAD, CiOBV, CiAccumulation, CiBWMFI, CiCustom` — OO wrappers over the 30+ built-in indicators, plus `CiCustom` to drive any custom indicator.
- **Infra**: `Arrays`, `Files` (`CFile/CFileBin/CFileTxt`), `ChartObjects`, `Objects`, `Panels/Dialogs`, `Generic` (`CArray*`, `CList`, `CHashMap`), `Math`, `OpenCL`, `Strings`.
- **Verdict:** the safe, supported, documented baseline. Bundled license = use in MetaTrader, **no redistribution as your own library**.

### 1b. MQL5.com CodeBase + Articles (non-GitHub, the largest indicator collection anywhere)
- `mql5.com/en/code` — tens of thousands of free indicators, scripts, EAs, and libraries; `mql5.com/en/articles` — long-form library/tutorial code.
- **This is the canonical "indicator collection"**: most GitHub indicator repos are re-uploads/forks of CodeBase items.
- License: per MQL5.com rules (free to use, redistribution restricted), **not OSI**. Download is per-file (no bulk clone).

---

## 2. GitHub class-frameworks / reusable libraries (ranked by usefulness)

| # | Project (org/repo) | What it is | Lang | Adoption | License | Verdict |
|---|---|---|---|---|---|---|
| 1 | **EA31337 / EA31337-classes** | Large OOP framework used by the EA31337 EA: indicator/strategy base classes, `Collection`, `Storage` (Redis/SQLite), JSON, chart/order/symbol/timer utilities | MQL5 | high (~hundreds ★) | check repo | The closest thing to a "standard community library"; best C++-style scaffolding to fork |
| 2 | **dingmaotu / mql4-lib** | OOP extension for MQL4: collections, strings, JSON, utils, debug — the de-facto MQL4 std-library add-on | MQL4/5 | high (~hundreds ★) | check repo (MIT-ish historically) | Best base if you're on MT4/MQL4 |
| 3 | **sibvic / mq4-tools** and **sibvic / mq5-tools** | Utility class libraries: collections, tick handling, indicator wrappers, helpers | MQL4 & MQL5 | medium | check repo | Good grab-bag of small utilities per terminal |
| 4 | Classic single-file includes (not full repos) | `OrderReliable.mqh` (reliable order send with retries), **JAson / CJAVal** (JSON), base64/hash/encoding helpers, `VirtualStops` | MQL4/5 | high | varied / often none | These small `.mqh` files are the real "library ecosystem" — look them up on CodeBase |

Notes:
- EA31337's org also carries the EA itself and strategy packs; the **`classes` repo is the reusable part**.
- dingmaotu is the single most prolific MQL library author on GitHub (see §3).
- Because there's no package registry, expect to **vendor** these (copy `.mqh` into `Include/`); versioning/upgrade is manual.

---

## 3. Wrappers & bindings (MQL ⇄ outside world) — the strongest GitHub niche

### Native DLL bindings (dingmaotu family — the backbone)
- **`dingmaotu/mql-zmq`** — ZeroMQ binding for MQL4/5 (messaging to Python/C++/etc.).
- **`dingmaotu/mql-sqlite3`** — SQLite3 binding (local DB from MQL).
- **`dingmaotu/mql-http`** — HTTP client/server for MQL (REST calls, headless serving).
- **`dingmaotu/mql-redis`** — Redis client (fast cross-process state / IPC).
- Pattern: a compiled DLL + an `.mqh` wrapper class. These are the plumbing every serious MT integration reuses.

### Bridge EAs (expose the terminal to another language)
- **`darwinex/dwx-zeromq-connector`** (a.k.a. DWX ZeroMQ Connector) — the best-known **MQL5 EA + Python/C++ clients** that turns MT4/MT5 into a ZeroMQ endpoint so external apps can trade. Widely copied; medium-to-high adoption. This is the reference "wrapper" of the lane.
- **REST/HTTP servers written in MQL** (several CodeBase/GitHub variants, e.g. "MQL5-REST"-style projects) — expose account/quote/order state as JSON.
- **TA-Lib DLL bindings**, PCRE/regex, OpenSSL/crypto, and base64 `.mqh` wrappers — thin native shims, mostly distributed via CodeBase.
- **Python `MetaTrader5` (official pip module)** — the dominant integration, but it is the **broker-api lane's** subject; note it here only as the boundary. `mt5linux` / Docker-Wine wrappers sit alongside it (also broker-api).

### Closed/commercial (listed so they're not mistaken for OSS)
- **MTsocketAPI** (paid DLL socket server), **MetaApi** (cloud), and various paid bridge EAs. **Not open source** — flagged for completeness, not recommended as "libraries".

---

## 4. Indicator collections on GitHub — what's actually there
Reality check: GitHub's indicator side is **fragmented, not "collections."** CodeBase is the collection. On GitHub you mainly find:
- **Re-uploads / forks** of popular CodeBase indicators (single-author, low stars).
- **Pine→MQL ports** of TradingView indicators (Renko/range bars, Supertrend, etc.).
- **"All-in-one" bundles** that are really a **funnel for a paid EA/brand** — the free file is bait.
- Recurring categories with real but scattered repos: **Renko / range-bar / Heikin-Ashi construction**, **Market-Profile / volume-profile**, **harmonic & candlestick pattern recognition**, **ICT / Smart-Money order-block & supply-demand**, **divergence**.
- There is **no well-maintained "awesome-mql5" list** of note; discovery happens via MQL5.com CodeBase search and `topic:mql5` / `topic:metatrader` on GitHub.
- **Licensing**: the majority of these carry **no license** → legally *not* open source even though the source is visible. Assume "read for reference, don't ship."

---

## 5. Risks / AVOID
1. **`.ex4`/`.ex5`-only drops** (no `.mq` source) — the #1 malware vector in this ecosystem; decompilers are commonly trojaned.
2. **"Free premium EA / cracked / nulled" repos** — DLL/`WebRequest` exfiltration of account credentials; never run against a funded account.
3. **Unknown third-party DLLs** pulled in by "library" repos — full process access to your terminal.
4. **No-license MQL** masquerading as open source — visible code ≠ OSI license; check for a `LICENSE` file before reuse.
5. **CodeBase items ≠ open source** — respect MQL5.com redistribution rules.
6. **Agent/bridge EAs holding trade keys** — even the legitimate `dwx`/socket bridges are sensitive; run on a **demo account first**, never enable withdrawals.

---

## 6. Practical picks for a solo dev (today)
- **Base layer:** build on the **Standard Library** (`Trade\Trade.mqh`, `Expert.mqh`, `Indicators\Ci*`) + mine **MQL5.com CodeBase** for indicators. Zero risk, best docs.
- **OOP scaffolding:** fork **EA31337-classes** (MQL5) or **dingmaotu/mql4-lib** (MQL4) instead of writing collections/JSON/storage from scratch.
- **External integration:** use **darwinex/dwx-zeromq-connector** (whole-terminal bridge) or the finer-grained **dingmaotu mql-zmq / mql-sqlite3 / mql-http / mql-redis** for one capability at a time.
- **Before funding anything:** vendor the includes locally, confirm a `LICENSE`, run bridges on **demo**, and never enable withdrawal permissions on API/agent keys.
- **Boundary:** for pure Python↔MT5 control (`MetaTrader5` pip) and native/manager-API bridges, follow the **broker-api** lane; for assigning individual indicator ports, follow the **mt5-indicator** lane.

---

## Appendix — reproduce this survey with live data
- GitHub code/repo search: `topic:mql5`, `topic:mql4`, `topic:metatrader`, `mql5 library`, `mql4 include`, `mqh classes`, `metatrader5 zeromq`, `mql sqlite`, `language:MQL5`.
- MQL5.com: `mql5.com/en/code` (filter by type = Indicator / Library), `mql5.com/en/articles`.
- Screen every hit for: real `.mq`/`.mqh` source (not just binaries), a `LICENSE` file, last-push date, and any bundled DLL.

**Bottom line for this lane:** the "collection" is MetaQuotes' built-in Standard Library plus MQL5.com CodeBase; the reusable **GitHub library layer is small** and dominated by **EA31337-classes**, the **dingmaotu binding family**, and the **Darwinex ZeroMQ connector**. Everything else is single-author includes, indicator re-uploads (use CodeBase instead), or paid/binary bait to avoid.