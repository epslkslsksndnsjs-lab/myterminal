I have the full picture: this is lane `d0006` (`forex-strategy`) of run `wf_71a518c957daaf7c`, a 15-lane MT4/MT5+forex survey. The path is read-only with a fixed safe-read allowlist (`src/workflows/tool-command.ts`) — no network egress exists, and I verified no FX corpus is cached in the workspace. Sibling lanes (d0001 mt5-ea, d0003 mt5-lib, d0008 forex-backtest) hit the same wall and returned curator's maps; my lane must cover the distinct *strategy-research* half and cross-reference theirs.

# FX Strategy Research & Backtesting — Open-Source Strategy-Research Stack

**Lane:** `forex-strategy` · **Keyword:** "forex algorithmic strategy" · **Focus:** FX strategy research and backtesting · Run `wf_71a518c957daaf7c` (script `.myterminal/workflows/saved/mtfx.js`), 2026-10-04. **Position:** this lane owns the *research* half — how strategies are formulated, coded, validated and reported. Execution-simulation engines and MT5-tester wrappers are the sibling `forex-backtest` lane (d0008); do not double-count them.

## Method and a hard caveat (read first)

This path is **read-only and network-blocked at the tool layer**. I verified it: `curl`, `wget`, `gh`, `openssl s_client`, `nc`, `dig`, `python3`, `node -e`/`bun -e`, and `bash -c` all return `not-in-read-only-allowlist`. The allowlist itself is in this repo — `src/workflows/tool-command.ts` → `SAFE_READ_COMMANDS` — and is purely local reads (`ls/cat/grep/find/sed/jq/git status|log|show/…`, `node|bun --version`); there is **no network verb in it**. A tree-wide `grep -ri "backtrader|vectorbt|pysystemtrade|zipline|oanda|quantconnect|mql5|forex"` over `/Users/Admin/myterminal` returns **zero FX/strategy artifacts** — the only corpus on disk (`gh_search/`, `verify2/`, `gem-research/`, `.scratch/airdrop_research/`) is the sibling CEX-listing-sniper work, and the only MQL/forex hit is the workflow script itself.

So this lane **could not** be populated from GitHub Search/Repo API responses the way `cex_listing_sniper_report.md` was. It is a **curator's map from domain knowledge, not an API-verified listing**. Repo *identities* are high-confidence; **stars/forks/pushed dates are deliberately omitted rather than invented**, and licenses carry explicit confidence tags. Everything is tagged *needs live re-verification*. The structural findings and the risk section are the parts I would stand behind. (I also read this run's own lane ledger — `runs/wf_71a518c957daaf7c/agents/d0001,d0003,d0008.json` — to keep coverage disjoint from `mt5-ea`, `mt5-lib`, `mt4-ea`, `mt5-bot` and `forex-backtest`.)

---

## 1. Framing — why "strategy research" is its own lane

Backtesting an equity is one problem; *researching an FX strategy* is another, for four reasons that shape every tool below:

1. **The research unit is a hypothesis about a relative price, not an asset.** FX has no "market return" to beat — EURUSD's drift is ~0. The research question is always *vs. another currency, a carry differential, or a regime*. That pushes the whole lane toward **factor/signal analysis** (alphalens-style) rather than buy-and-hold equity backtests.
2. **Signal and execution are different projects.** A research stack answers *"does this edge exist, out-of-sample, after costs?"*; an execution engine answers *"did I fill it?"* The good research stacks (pysystemtrade, vectorbt, alphalens) intentionally stop at the signal; the good engines (Lean, backtrader, nautilus — d0008) take the signal as given. Confusing the two is the lane's most common error.
3. **Overfitting is the dominant failure mode, and it is statistical, not computational.** With 28 majors+crosses, 5 timeframes and free parameter search you can fit noise trivially. The lane's centre of gravity is therefore **validation methodology** (walk-forward, CPCV, PBO, deflated Sharpe) — see §5.
4. **Carry/swap is a first-class research input.** FX is the only retail market where *holding* earns/pays a rate differential; a research stack that can't model swap cannot study carry, the single most-documented FX risk premium.

The result: the lane splits into **(A) research-first Python libraries**, **(B) strategy families with canonical OSS anchors**, **(C) the robustness/validation toolkit**, and **(D) the MT4/MT5 research shelf** (tester + CodeBase + builders).

---

## 2. The research pipeline and the OSS stack per stage

```
[idea / economic prior] → [data] → [signal & features] → [backtest] → [validation] → [report & iterate]
   paper/book/Quantpedia   findatapy  pandas / pandas-ta    vectorbt     CPCV / PBO /     quantstats
   SSRN / Carver           Dukascopy  TA-Lib / ta           backtrader   walk-forward     alphalens
   MQL5 articles           yfinance   alphalens (factors)   pysystemtrade Monte-Carlo     pyfolio-reloaded
   QuantConnect community  (→ data lane d0007)              (→ engine lane d0008)  (deflated Sharpe)  ffn / empyrical
```

| Stage | Best-fit OSS anchor | Confidence | Notes |
|---|---|---|---|
| Data | `cuemacro/findatapy`, Dukascopy tools, `yfinance` (`EURUSD=X`) | high / med | **→ `forex-data` lane (d0007); de-dup here.** |
| Signals / TA | `twopirllc/pandas-ta`, `TA-Lib/ta-lib-python`, `bukosabino/ta`, `peerchemist/finta` | high | Research-side feature/signal generation. |
| Factor / signal eval | `stefan-jansen/alphalens-reloaded` | high | The single most under-used FX research tool: ranks *signals* (forward-return by quantile, IC, turnover) before you build a strategy. |
| Strategy framework | `robcarver17/pysystemtrade`; `mementum/backtrader`; `polakowo/vectorbt` | high | Research-first; also engines (d0008). |
| Validation | `hudson-and-thames/mlfinlab` (+ AFML book), `vectorbt` walk-forward | medium | See §5. |
| Reporting | `ranaroussi/quantstats`, `stefan-jansen/pyfolio-reloaded`, `pmorissette/ffn`, `empyrical-reloaded` | high | Tearsheets: Sharpe/Sortino/Calmar, drawdown, tail, rolling. |

---

## 3. Research-first libraries & frameworks (the shortlist)

- **`robcarver17/pysystemtrade`** — GPL-3.0 *(high)*. **The best open-source artifact in this entire lane.** Rob Carver's full systematic-trading framework: instrument config, forecast scaling/combining, volatility targeting, and a **production** system as well as a backtester, aimed squarely at futures+FX. It is the reference implementation of the *"Systematic Trading"* method (EWMAC trend, carry, breakout, value). Heavy, idiosyncratic, but genuinely end-to-end.
- **`mementum/backtrader`** — **GPL-3.0** *(high confidence, and a correction to the sibling `forex-backtest` lane which recorded MIT)*. Event-driven; multi-feed/timeframe/resampling; pluggable commission and **swap/carry model**; Oanda/IB broker stores. The default Python base for a hand-written FX strategy research harness.
- **`polakowo/vectorbt`** — Apache-2.0 open core *(high)*; `vectorbt PRO` is paid. Vectorized/Numba — the right tool for **large parameter sweeps and walk-forward grids**, i.e. *strategy search*; bar-based, so not tick-microstructure-accurate (that's d0008's territory).
- **`kernc/backtesting.py`** — **AGPL-3.0** *(medium-high; the AGPL tag matters for reuse)*. Minimal single-asset event backtester — the fastest way to falsify a simple FX idea.
- **`QuantConnect/Lean`** — Apache-2.0 *(high)*. Local `lean backtest` CLI + **native FX (OANDA/FXCM)**; scriptable in Python/C#. The strongest *open, tick-capable, FX-native* research-to-live path. Cloud-centric.
- **`nautechsystems/nautilus_trader`** — **LGPL-3.0** *(medium; sibling said Apache-2.0 — verify)*. High-performance event-driven backtest+live with FX adapters.
- **`cuemacro/finmarketpy`** — Apache-2.0 *(medium-high)*. **FX-specific** research/backtesting library by Saeed Amen (author of *Trading the FX Markets*); pairs with `cuemacro/findatapy`. The most explicitly FX-research-oriented Python package in the lane.
- **`kieran-mackle/AutoTrader`** — MIT *(medium)*. Explicitly FX-first (Oanda/IB/CCXT) research + live framework with a strategy class and backtest/broker abstractions.
- **`stefan-jansen/machine-learning-for-trading`** + `zipline-reloaded` / `alphalens-reloaded` / `pyfolio-reloaded` — the maintained **Quantopian stack** *(high)*; the book repo ships notebooks that bridge backtest → ML → portfolio, and is the best free curriculum for "research an FX strategy properly".
- **`pmorissette/bt` / `ffn`** — MIT *(high)*. Weight/portfolio-level backtesting + performance analytics; useful for FX *allocation* research (multi-pair portfolios), not tick execution.
- Marked-boundary / crypto-only: **`freqtrade`**, **`jesse`**, **`hummingbot`** — crypto, **not FX**; include only as *architecture references* (same contamination pattern the CEX lane hit).
- **R stack:** `quantstrat` + `blotter` + `PerformanceAnalytics` + `quantmod` + `TTR` (all GPL) — a complete research+accounting stack with a real book/ledger; the mature non-Python option. *(Cross-ref `forex-backtest`.)*

---

## 4. FX strategy families and their canonical OSS anchors

This is what a "strategy" survey is actually for — the reusable *idea ↔ code* map.

| # | Family | Economic basis | Canonical OSS anchor | Confidence |
|---|---|---|---|---|
| 1 | **Trend / momentum** | behavioural under-reaction; central-bank smoothing | `pysystemtrade` (EWMAC; Carver), `backtrader` MA/Donchian samples, `je-suis-tm/quant-trading` | high |
| 2 | **Carry** | interest-rate differential / forward bias | `pysystemtrade` carry rule; needs a swap model (backtrader/Lean) — **the FX-unique family** | high (concept) / med (clean OSS impls) |
| 3 | **Mean-reversion / range** | liquidity reversion intraday | `backtesting.py` / `vectorbt` examples; Bollinger/z-score on `pandas-ta` signals | high |
| 4 | **Pairs / cointegration / stat-arb** | relative value / spread stationarity | `hudson-and-thames/arbitragelab` (Apache-2.0 *med*), `statsmodels` cointegration, `quant-trading` | med |
| 5 | **Breakout / seasonality / session** | London/NY session liquidity; opening-range effects | `quant-trading` (London breakout), codeable in any engine | med |
| 6 | **ML / RL signal** | non-linear feature→return mapping | `stefan-jansen/machine-learning-for-trading`, `microsoft/qlib`, `AI4Finance-Foundation/FinRL`, community LSTM/transformer notebooks | med (fx-specific impls thin) |

**Research finding:** OSS coverage is *inverted* relative to practitioner interest. Families 1–3 have many implementations; **carry** (the one FX-specific premium) has almost none because it needs a broker swap table; **pairs/stat-arb** is served by equities-oriented libraries that must be re-pointed at FX; **ML** repos are mostly crypto/equity and only nominally "forex". The honest statement is: *the FX strategy families are well documented in books/papers and thinly implemented in code.*

---

## 5. Validation & robustness toolkit — the lane's real substance

The differentiator between "profitable backtest" and "profitable strategy" is here, and it is mostly **borrowed from López de Prado's *Advances in Financial Machine Learning* (AFML)**:

- **Walk-forward / rolling out-of-sample** — anchor-and-rebuild; native in `pysystemtrade` and `vectorbt` (PRO especially). The minimum bar.
- **Purged & embargoed K-fold CV, Combinatorial Purged CV (CPCV)** — `mlfinlab` implemented these; the concept is the important part and is re-implementable. *(mlfinlab's GitHub repo is **effectively withdrawn/unmaintained** — the company moved commercial; **verify before relying** — the AFML book and community forks are the durable source.)*
- **Deflated Sharpe Ratio, Probability of Backtest Overfitting (PBO), Minimum Backtest Length** — Bailey & López de Prado; `mlfinlab` had them; otherwise implement from the papers.
- **Monte-Carlo trade resampling / bootstrap of the equity curve** — in `vectorbt` PRO and as trivial scripts.
- **Volatility modelling / regime tests** — `bashtage/arch` (GARCH) + `statsmodels`; "does the edge survive in the low-vol regime?" is an FX-specific necessity.
- **Tearsheets & statistical report** — `quantstats`, `pyfolio-reloaded`, `ffn`, `empyrical-reloaded`; `alphalens-reloaded` for factor IC/turnover.

**Cross-lane note:** MT-world equivalent of this whole section is the MT5 Strategy Tester's **forward-test** and **genetic optimization**, plus Monte-Carlo/Walk-Forward-Matrix in the *closed* **StrategyQuant** — see §6 and d0008.

---

## 6. The MT4/MT5 strategy-research shelf (MQL side)

Strategy research in the MetaTrader world does **not** look like GitHub — it is the terminal plus MQL5.com:

- **MT5 Strategy Tester as the research instrument** (real-tick mode, genetic optimization, `OnTester()`, forward test) — **owned by d0008**, referenced only. *Key correction to carry up: the `MetaTrader5` Python package is **not** a backtester or research tool; it is a data/trade API to a running terminal.*
- **MQL5.com CodeBase + Articles** (`mql5.com/en/code`, `/articles`) — the actual library of MT strategies/indicators and backtest write-ups; off-GitHub, per-file, not OSI.
- **`EA31337/EA31337-strategies`** — GPL-3.0 *(high)* — a *version-controlled, CI-tested collection of open MQL strategies* (MA/RSI/MACD/breakout modules). The rare open "strategy pack"; cross-ref `mt5-ea` (d0001) which anchors on the EA itself.
- **Forex Strategy Builder (FSB)** — open-source .NET: visual strategy construction + its own tick backtester + MQL codegen; **Expert Advisor Studio** is the closed successor. *Strategy-builder* role; cross-ref `mt5-ea`.
- **StrategyQuant X / QuantAnalyzer** — closed commercial tier that owns the "generate + robustness-test EA strategies" workflow (Walk-Forward Matrix, Monte-Carlo, PBO-style metrics). Name it so the open-source gap is honest.
- **TradingView Pine Strategy Tester / webhook strategies** — a research surface popular for FX; cross-ref `tradingview` lane.

---

## 7. Off-GitHub shelves the lane silently depends on

- **QuantConnect community + `QuantConnect/Research`** — shared Lean strategies and research notebooks (the largest open *FX-capable* strategy sample set).
- **MQL5 CodeBase/Articles** (§6).
- **Quantpedia** (paid) — the canonical encyclopedia of documented (mostly FX/futures) anomalies; **SSRN / arXiv q-fin** for the primary papers; **`paperswithbacktest`**-style sites for paper→code.
- **Kaggle** FX datasets/notebooks; **Forex Factory / Elite Trader / Wilmott** for practitioner methodology.
- **Books as the de-facto spec:** Carver *Systematic Trading*; López de Prado *AFML*; Ernest Chan *Algorithmic Trading*/ *Machine Trading*; Saeed Amen *Trading the FX Markets*.

---

## 8. What open source lacks (this lane's real finding)

1. **No maintained OSS implementation of FX carry with a proper swap/rollover model.** The most-documented FX premium is the least implemented.
2. **No FX-native factor/signal research library.** `alphalens` is equities-oriented; `finmarketpy` is the closest and is single-author.
3. **Validation tooling is fragmented and partly withdrawn** — `mlfinlab` gutted; CPCV/PBO/deflated-Sharpe live mostly in papers, not maintained packages.
4. **The MT world and the research world do not share a strategy representation.** MQL strategies live in the terminal; research strategies live in Python; nothing round-trips them, so "research then deploy as an EA" is manual re-implementation.
5. **Cross-broker reproducibility is unsolved** — same finding as d0008: swap tables, server-time offsets and tick provenance aren't normalized by any open tool, so FX research results are broker-specific by construction.

---

## 9. AVOID / risk flags

1. **"99% win-rate EA + backtest screenshot" funnels** — README marketing → paid Telegram; no walk-forward, no costs, no swap. Same `AVOID` pattern as `cex_listing_sniper_report.md`.
2. **Curve-fitted/optimizer overfit results presented as strategy research** — the lane's central hazard; demand out-of-sample, PBO and deflated Sharpe before believing any published FX backtest.
3. **Backtests that ignore spread, commission or swap** — a "profitable FX backtest" without all three is fiction; engine choice (d0008) determines which are even modelled.
4. **`.ex4`/`.ex5`-only or decompiled EA "strategies"** — license-violating and a documented malware/credential-theft channel (cross-ref `mt5-ea`, `mt5-lib`).
5. **`curl | bash` one-line installers and bundled DLLs** in "strategy library" repos.
6. **No `LICENSE` = all rights reserved.** Most small FX-strategy repos ship none; "public repo" ≠ reusable.
7. **Crypto contamination** — `freqtrade`/`jesse`/most "forex trading bot" hits are crypto-only; exclude from FX counts.

---

## 10. Queries to close this lane with live data (run where network exists)

Fetch `stars/forks/license/created/pushed/archived/issues` per repo exactly as the CEX lane did, for: `pysystemtrade` · `backtrader` · `vectorbt` · `backtesting.py` · `nautilus_trader` · `pybroker` · `bt` · `ffn` · `quantstats` · `finmarketpy` · `AutoTrader` · `pyalgotrade` · `zipline-reloaded` · `alphalens-reloaded` · `pyfolio-reloaded` · `mlfinlab` · `arbitragelab` · `EA31337-strategies` · `machine-learning-for-trading` · `qlib` · `FinRL` · `pandas-ta` · `ta-lib-python`.

Then broaden by **topic/tag search** (`topic:forex`, `topic:fx`, `topic:algorithmic-trading`, `topic:backtesting`, `topic:quantitative-finance`) and by **strategy-name search** (`forex carry`, `fx trend following`, `pairs trading forex`, `systematic trading`, `expert advisor strategy`), and fetch **MQL5 CodeBase/Articles + QuantConnect community** separately — GitHub search cannot reach where MT strategy code and most FX strategy write-ups actually live.

---

## 11. Handoff notes for the reducer

- **Shortlist to promote:** `robcarver17/pysystemtrade` (top pick), `mementum/backtrader`, `polakowo/vectorbt`, `QuantConnect/Lean`, `stefan-jansen/{machine-learning-for-trading, zipline-reloaded, alphalens-reloaded, pyfolio-reloaded}`, `cuemacro/finmarketpy`, `kieran-mackle/AutoTrader`, `kernc/backtesting.py`, `pmorissette/{bt,ffn}`, `ranaroussi/quantstats`; MT-side `EA31337/EA31337-strategies`, FSB, MQL5 CodeBase.
- **Cross-lane de-dup:** engine/tester detail → **`forex-backtest` (d0008)** — I list engines only to frame the research stack; FX tick data & downloaders → **`forex-data` (d0007)**; MetaTrader5 pip / mt5linux / Oanda adapters → **`broker-api`**; EA31337 EA itself → **`mt5-ea` (d0001)** and libraries → **`mt5-lib` (d0003)**; `freqtrade`/`jesse` are **crypto, exclude** from FX.
- **Corrections to carry up:** (a) `backtrader` is **GPL-3.0, not MIT** (sibling d0008 recorded MIT); (b) `nautilus_trader` is likely **LGPL-3.0** (verify); (c) the **`MetaTrader5` Python package is not a backtester or research tool** — do not let that claim enter the umbrella report.
- **Confidence:** structural findings (§1, §4-row-, §5, §8) = **high**; named-repo list = **medium/high**; **all numeric metadata unverified on this path — publish no star/date figures from this report.** Coverage gap: needs one API pass + an MQL5 CodeBase/QuantConnect fetch.