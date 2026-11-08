# Forex Backtesting — Open-Source Backtest Engines & MT5 Tester Wrappers

**Lane:** `forex-backtest` · **Keyword:** "forex backtesting" · **Focus:** Backtest engines and MT5 tester wrappers · Run `wf_71a518c957daaf7c` (script `.myterminal/workflows/saved/mtfx.js`), 2026-10-04.

## Method and a hard caveat (read first)

This path is **read-only and network-blocked at the tool layer**. I verified it directly: `curl`, `which`, and every non-allowlisted shell verb return `not-in-read-only-allowlist`; there is no network egress here. A repo-wide grep for `backtest|backtesting|tester|backtrader|backtesting.py|vectorbt|zipline|freqtrade|MetaTrader5|mql5|mql4` over the whole workspace returns **zero** forex/backtest artifacts — the only corpus on disk (`gh_search/`, `verify2/`, `gem-research/`) is the sibling **CEX-listing-sniper** lane, and the only MQL/MT hits are the workflow script itself.

So this lane **could not be populated from the GitHub Search / Repo API** the way the CEX report was. What follows is a **curator's map from domain knowledge, not an API-verified listing**. Repo *identities* below are high-confidence; **stars/forks/pushed dates are deliberately omitted rather than invented**, and licenses are marked with confidence. Every named repo is tagged *needs live re-verification* before it is published as fact. The structural findings (§1–§4) are the parts I would stand behind.

---

## 1. What makes "forex backtesting" its own lane (framing)

A forex backtest is not a generic equity backtest with a different ticker. Four cost/microstructure facts dominate correctness, and every engine below is really a different answer to them:

1. **Bid/ask + spread is the whole game.** FX is a two-sided, dealer-quoted market. A bar-close engine that trades at "the close" silently assumes zero spread. Fidelity runs: open-price → 1-min OHLC → interpolated ticks → **real ticks with real bid/ask**. This single axis explains most of the lane.
2. **Swap / rollover (carry) and commission.** Brokers charge per-lot commission plus a daily swap on held positions; ignoring swap turns multi-day strategies into fiction. Engines that lack a swap model are not usable for swing FX.
3. **Broker/data provenance.** "Real ticks" are only real for *that broker's* feed. The same EA can be profitable on one broker's tick history and losing on another's; tick timestamps are also broker-server-time, not UTC.
4. **Intrabar path ambiguity.** On OHLC bars, whether a stop or a target was hit first is unknowable inside the bar — the classic backtest optimism/look-ahead source. Only real-tick simulation resolves it.

This is why the lane splits cleanly into two halves that are often confused: **(A) the tester built into the MetaTrader terminal**, and **(B) standalone engines** (Python/R/C++) that pull FX data and simulate execution themselves. They share almost no code.

---

## 2. Layer map of the lane

```
[FX price data]  ──►  [Execution simulator]  ──►  [Sweep/optimizer]  ──►  [Report & metrics]
 Dukascopy ticks        MT5 Strategy Tester        genetic / grid /        MT5 HTML report,
 broker M1/M1-tick      MT4 tester (weak)           walk-forward            QuantStats, pyfolio,
 broker REST history    backtrader / LEAN /                                  StrategyQuant (closed)
 (→ forex-data lane)    backtesting.py / vectorbt /
                        pyalgotrade / Nautilus /
                        finmarketpy / AutoTrader
```

Two structural findings for the reducer:

- **There is no official headless API for the MT5 Strategy Tester.** MetaQuotes ships no socket/REST entry point to "run a backtest." Everything sold or shared as an "MT5 tester wrapper" is glue over (i) launching `terminal64.exe /config:<tester.ini>` and (ii) scraping the report. That is the entire category — and it is small, brittle, and mostly DIY.
- **The official `MetaTrader5` Python package cannot run backtests.** It reads history and trades on a *running* terminal (Windows-only, closed freeware). People routinely mistake it for a backtester; it is not. It is a *data source* you can build a custom bar-based backtester on top of — nothing more.

---

## 3. The MT5 Strategy Tester and its wrappers (this lane's core)

### 3.1 What the in-terminal tester actually provides (high confidence)

- **Simulation modes:** "Every tick based on real ticks" (the only high-fidelity mode), "Every tick" (interpolated from M1), "1 minute OHLC", "Open prices only", "Math calculations". Real ticks come from MetaQuotes' tick database for standard symbols, free where the broker exposes them — otherwise the mode degrades silently.
- **Multithreaded optimization:** complete / fast / **genetic**; custom optimization criterion via `OnTester()`; **forward testing** (in-sample/out-of-sample split); **multicurrency/multi-symbol** testing from one EA.
- **Distributed compute:** local **agents** (one per core) and the **MQL5 Cloud Network** (paid).
- **Report + programmatic readout:** an HTML report for humans; for machines, `TesterStatistics()` (profit factor, drawdown, Sharpe, custom) and `OnTester()` returning a number. **FrameAdd/FrameNext** stream custom per-pass data out during optimization.

### 3.2 The wrapper pattern (what "MT5 tester wrapper" means in practice)

No framework dominates; the reusable open pattern is a **thin orchestrator** around the terminal's own CLI:

1. **Generate config.** Write `tester.ini` with `[Tester]` keys — `Expert`, `ExpertParameters` (a `.set` file), `Symbol`, `Period`, `Model` (0..4), `FromDate`/`ToDate`, `Deposit`, `Currency`, `Leverage`, `Optimization`, `OptimizationCriterion`, `ForwardMode`, `Report=…`, `ShutdownTerminal=1`. The `[Common]` section sets the data dir.
2. **Generate `.set` files** for parameter ranges (the same format the GUI's optimization tab produces).
3. **Launch** `terminal64.exe /config:"…\tester.ini"` as a subprocess; one terminal instance per data directory; on Linux, under **Wine** (or a Wine/Docker image — see §5).
4. **Collect.** Parse the HTML/`.xml` report, or (cleaner) have `OnTester()`/`FrameAdd` write a CSV and read that back. Optimization results are cached in an opaque binary, so per-pass CSV emission is the reliable machine channel.
5. **Sweep / walk-forward** by rewriting the ini per run and merging the CSVs.

Known open-source wrappers are typically single-author scripts (`subprocess` + config templating + `pandas.read_html`), not maintained libraries. **None is a canonical "MT5 tester API"; treat the category as an unclaimed gap, not a set of picks.**

### 3.3 MT4 tester (the legacy half)

MQL4's tester is frozen and materially weaker: no real ticks, "every tick" is generated from M1 bars, fixed-spread defaults. The **dominant fidelity fix is closed-source** — **Tick Data Suite (TDS)** injects real tick files with variable spread/commission, and **FX Blue** ships free tester utilities. Open-source MT4 testers are effectively nonexistent; the ecosystem route is "improve the fake ticks," not "replace the tester." *(Cross-ref `mt4-ea`.)*

### 3.4 Code-generating strategy builders with a built-in backtester

- **Forex Strategy Builder (FSB)** — open-source (.NET, SourceForge lineage, author Miroslav Popov): visual strategy construction, its **own tick backtester**, and **MQL4/MQL5 code generation**. The best-known "build an EA without writing MQL, then test it" open tool. Successor **Expert Advisor Studio** is the closed hosted version.
- **StrategyQuant X / QuantAnalyzer**, **Forex Tester**, **Soft4FX** — the closed commercial tier that dominates practitioner workflow; name them so the "open-source" gap is honest.

---

## 4. Standalone open-source FX-capable backtest engines

These simulate execution themselves and are the genuinely reusable open-source layer. Grouped by what an FX backtest actually needs.

**Serious engine, FX-capable, event-driven**
- **`mementum/backtrader`** — *the* retail reference for FX backtests. Multiple data feeds/timeframes, resampling, pluggable commissions, and broker stores including **Oanda**; persistent community. License MIT (high confidence). Practically the default starting point for a Python FX strategy backtest. *(needs live re-verification)*
- **`QuantConnect/Lean`** — Apache-2.0 (high confidence). Full open engine with **native Forex support (OANDA, FXCM)**, tick-level modelling, and a local `lean backtest` CLI. The strongest "open, scriptable, tick-level, FX-native" option; heavy C# core, cloud-centric data. *(needs live re-verification)*
- **`nautechsystems/nautilus_trader`** — Apache-2.0 (high confidence). High-performance event-driven engine with **FX via Interactive Brokers / Oanda adapters**. Trending; sharper learning curve than backtrader.
- **`edtechre/pybroker`** — Apache-2.0 (high confidence). Event-driven, fast; FX/exchange access via adapters (broker coverage is the thing to verify for FX specifically).

**Lightweight / research engines**
- **`kernc/backtesting.py`** — minimal single-asset event backtester; popular for quick FX ideas. License **AGPL-family (verify exact tag — it matters for reuse).**
- **`polakowo/vectorbt`** (open core, Apache-2.0) vs **vectorbt PRO** (paid) — vectorized/Numba, excellent for **huge parameter sweeps and walk-forward**, but bar/vector-based: not tick-microstructure accurate. Good for *strategy search*, wrong for *execution realism*.
- **`pmorissette/bt` / `ffn`** — portfolio/allocation backtesting + metrics; not tick FX.
- **`ranaroussi/quantstats`** — performance analytics layer, pairs with backtrader/vectorbt output; not an engine itself. **(Cross-ref reporting.)**

**FX-specific / niche**
- **`cuemacro/finmarketpy`** — FX-focused backtesting & market-analysis research (author Saeed Amen); pairs with **findatapy** for data. *(Cross-ref `forex-data`; verify license/activity.)*
- **AutoTrader** (kieran-mackle) — Python FX/crypto backtest + live framework with Oanda/IB/CCXT adapters; the most explicitly *forex-first* of the standalone frameworks. *(needs verification)*
- **`gbeced/pyalgotrade`** — older, still-cited event backtester with a broker model and exchange feeds; effectively maintenance-mode. *(needs verification)*
- **`zipline` / `stefan-jansen/zipline-reloaded`** — Apache-2.0; **equities-centric**, FX is a fight; include only to mark the boundary.
- **R stack** — **`quantstrat` + `blotter` + `PerformanceAnalytics`** (GPL): a complete FX/quant backtesting-and-accounting stack with a real book/ledger model; the mature non-Python option.

**Keyword collisions to exclude:** **`freqtrade`**, **`jesse`**, and most "crypto trading bot" hits are **crypto-only** — they appear under "forex backtesting" searches but do not trade FX. Include only as *architecture references*, clearly labeled. This mirrors the CEX-lane contamination pattern.

---

## 5. Enabling infrastructure the lane silently depends on

- **Real-tick FX data**: Dukascopy tick downloaders, broker MetaTrader5 history exports, `findatapy` — **belongs to `forex-data`**; de-dup there.
- **MT5-under-Wine/Docker** images (e.g. MetaTrader5 + VNC/Wine images) — the only way to run the MT5 tester on Linux/CI. *(needs verification; verify the exact repo.)*
- **`mt5linux`** — RPyC shim to drive the `MetaTrader5` package from Linux; relevant because tester wrappers and data extraction are Windows/Wine-bound. *(Cross-ref `broker-api`.)*

---

## 6. Where open source is weak (the lane's real finding)

1. **No maintained OSS MT5 tester wrapper with a stable API.** The category is DIY `subprocess`+ini+report-scraping. Anyone wanting scheduled/CI backtests must build it.
2. **No OSS equivalent of Tick Data Suite** for real-tick, variable-spread, commission-accurate MT4/MT5 simulation.
3. **Cross-broker reproducibility is unsolved in OSS** — tick history provenance, server-time offsets and swap tables aren't normalized by any open tool.
4. **The honest "engine" and the honest "execution model" are still separate projects** — the good FOSS engines (backtrader/LEAN) don't speak MQL, and the good FOSS MQL layer doesn't offer an external API.

---

## 7. Risk / anti-pattern flags for this lane

- **"99% modelling quality / 99% win-rate EA" funnels** — README marketing with no reproducible ticks; the same Telegram/DM-funnel pattern flagged `AVOID` in the sibling `cex_listing_sniper_report.md`.
- **Tester-hack DLLs and "backtest booster" binaries** — MT4/MT5 DLLs that claim to "fix" or override the tester are a top **malware / account-theft** vector; anything requesting terminal DLL permission or credentials is radioactive.
- **Cracked Tick Data Suite / pirated StrategyQuant** — license violations bundled with installers; do not touch.
- **Decompiled `.ex4`→`.mq4` "source"** — legally and security-wise radioactive; same class as the `mt4-ea` lane's warning.
- **Overfitting / curve-fitting**, and **ignoring swap, spread and commission** — the two ways a "profitable backtest" is still worthless.
- **No `LICENSE` = all-rights-reserved.** Most small tester-wrapper/EA repos carry none; "public repo" ≠ "reusable."

---

## 8. Queries to actually close this lane (run where network exists)

Search repo names, then record `stars/forks/license/created/pushed/archived/issues` from the Repo API exactly as the CEX lane did:

`forex backtesting` · `mt5 tester wrapper` · `metatrader5 strategy tester python` · `mt4 backtest` · `metatrader backtest automation` · `mt5 optimization python` · `forex backtest engine` · `backtrader forex` · `fx backtest` · `quantconnect forex` · `forex strategy builder` · `metatrader docker wine tester` · `tick data mt4` · `mt5 report parser`.

Then **close the two real gaps explicitly**: (a) search **by file** (`tester.ini`, `*.set`, `TesterStatistics`, `OnTester`, `FrameAdd`) rather than repo name, since the wrapper layer is file-pattern-defined; (b) fetch **MQL5.com CodeBase / Market** separately — the tester utilities and most MT4/MT5 tooling live there, not on GitHub.

---

## 9. Handoff notes for the reducer

- **Highest-value open-source anchors** (shortlist): `mementum/backtrader`, `QuantConnect/Lean`, `nautechsystems/nautilus_trader`, `polakowo/vectorbt`, `kernc/backtesting.py`, `pmorissette/bt`, plus FX-specific `cuemacro/finmarketpy` and AutoTrader. Closed baselines to name for honesty: MT5 built-in tester, Tick Data Suite, FX Blue tester tools, StrategyQuant/QuantAnalyzer, Forex Tester.
- **Cross-lane de-dup:** FX tick data + downloaders → `forex-data`; `MetaTrader5` package / `mt5linux` / Oanda adapters → `broker-api`; `EA31337`, MT4 tester fidelity → `mt4-ea`; strategy *construction* overlap → `forex-strategy`; `freqtrade`/`jesse` are **crypto**, exclude from FX counts.
- **Key correction to carry up:** the MT5 Python package **is not a backtester**, and there is **no official headless tester API** — do not let either claim enter the umbrella report.
- **Coverage gap:** the entire lane's metadata is unverified because this path has no network; it needs one API pass plus an MQL5 CodeBase fetch before any star counts or license claims are published.
- **Confidence:** structural findings (§1–§4, §6) = **high**; named-repo list and all metadata = **medium/unverified** on this path.