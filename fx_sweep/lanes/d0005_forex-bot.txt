# Forex Trading Bots — Python / Node, Multi-Broker
### GitHub survey · lane `forex-bot` · keyword **"forex trading bot"** · focus: *Python or Node forex bots, multi-broker*
Generated 2026-10-04.

**Method & provenance — read this first.** This lane ran on a **read-only tool face**: shell network commands (`curl`, `gh api`, `git ls-remote`) and interpreters are refused, so no live GitHub API request could be made from here. The numbers below therefore come from a **locally cached GitHub Search API dump** at
`/Users/Admin/WorkBuddy/2026-10-03-23-47-21/.scratch/gh_forex_raw.json` (fetched **2026-10-03**), produced by 12 `search/repositories?sort=stars&per_page=40` queries:
`metatrader` (4,038 total), `mt5` (8,196), `mt4` (3,174), `mql5` (2,765), `mql4` (1,277), `forex` (28,548), `expert advisor` (2,050), `trading bot forex` (1,243), `algorithmic trading forex` (435), `ctrader` (770), `fix protocol trading` (117), `backtesting trading engine` (1,490). Union = **340 unique repos**.
Fields available in the dump: `stars`, `language`, `description`, `topics`, `pushed_at`, `archived`. **Not** in the dump: `forks`, `license`, `created_at` → shown as `n/a`. There are **no README bodies** in this lane, so every "Evidence:" line is the repo **description/topics**, not README prose. Treat star counts as a star-farmable signal (see AVOID).

**Language mix of the 340-repo union** (the single most useful finding): Python **101**, MQL5 56, C# 28, HTML 25, none 23, C++ 16, MQL4 16, Java 13, Rust 12, **JavaScript 11, TypeScript 11**, Jupyter 10, C 7, Go 6. → Forex *bot* code is overwhelmingly **Python or MQL**, and **Node/JS is a thin fringe** (mostly data feeds, MT bridges and cTrader samples, not multi-broker bots).

**What "multi-broker" actually means in open-source FX.** Almost never per-broker REST SDKs. It is achieved via four routes: **(a) MetaTrader bridges** — one EA/connector works against *any* MT4/MT5 broker (PyTrader, aiomql, MetaApi, DWX); **(b) cTrader Open API / FIX** — protocol-level multi-broker (OpenApiPy); **(c) multi-asset frameworks with an FX adapter** (lumibot, blankly, AutoTrader); **(d) broker cloud aggregators** (MetaApi). Direct single-broker clients (OANDA, FXCM, IG, IBKR) are the norm and are each one-broker.

Ranking = real usefulness for a solo, low-budget user (real + runnable + actually places orders + maintained + genuinely multi-broker).

---

## 1. Lumiwealth/lumibot
- Stars **2100** · Python · Last push **2026-10-03** · Archived no · License n/a
- https://github.com/Lumiwealth/lumibot
- Python framework + AI agents that **place real trades across 12 brokers**; backtesting, live/paper, crypto–stocks–options–futures–**forex**–prediction markets.
- Runtime: Python. Broker coverage: **12 brokers** (topics: `broker`, `interactive-brokers`, `alpaca`) → **explicitly multi-broker**, forex included.
- Places real orders: yes. Actively maintained (pushed the survey day).
- Evidence: *"AI agents that actually place the trade. 12 brokers, real backtests, stocks options futures forex crypto and prediction markets."* (topics: `broker`, `forex`, `interactive-brokers`, `alpaca`, `crypto-trading`)
- Practical: **the best single pick for this lane** — the only actively-maintained Python framework that is both genuinely multi-broker and forex-capable, with a large community and real backtest→live path.

## 2. TheSnowGuru/PyTrader-python-mt4-mt5-trading-api-connector-drag-n-drop
- Stars **1059** · Python · Last push **2025-05-05** · Archived no · License n/a
- https://github.com/TheSnowGuru/PyTrader-python-mt4-mt5-trading-api-connector-drag-n-drop
- End-to-end Python ↔ **MetaTrader 4 & 5** connector with a drag-and-drop EA; ships strategies, live **and** paper trading, WebSocket bridge.
- Runtime: Python (+ MQL EA). Broker coverage: **MT4 + MT5** → broker-agnostic across any MetaTrader broker → **multi-broker via MetaTrader**.
- Places real orders: yes. Maintained (2025).
- Evidence: *"Open Source Trading Strategies & End-to-End solution connecting Metatrader4 & Metatrader5 with Python with a simple drag and drop EA. Fully tested … for live & paper trading."* (topics: `mt4-api`, `mt5-api`, `metatrader-4`, `metatrader5`, `strategies`, `websockets`)
- Practical: the most-starred practical Python↔MT bridge with ready strategies; the go-to if "multi-broker" for you means "any broker I can log into MT".

## 3. blankly-finance/blankly
- Stars **2480** · Python · Last push **2024-12-30** · Archived no · License n/a
- https://github.com/blankly-finance/blankly
- One package to build/backtest/deploy algos **across stocks, crypto and forex**; uniform API over multiple exchanges/brokers.
- Runtime: Python. Broker coverage: multi-exchange (topics `binance`, `coinbase`, plus FX venues) → **multi-venue incl. forex**.
- Places real orders: yes (deploy path). **Stalled since 2024-12.**
- Evidence: *"Easily build, backtest and deploy your algo in just a few lines of code. Trade stocks, cryptos, and forex across exchanges w/ one package."*
- Practical: the cleanest "one API, many venues" Python bot framework and the #1 hit for "trading bot forex" (2480★), but ~10 months without a push — usable, verify the FX adapter before trusting it live.

## 4. metaapi — metaapi-python-sdk **+** metaapi-javascript-sdk
- Stars **91** (Python) / **97** (Node) · Last push **2026-05-12** (both) · Archived no · License n/a
- https://github.com/metaapi/metaapi-python-sdk · https://github.com/metaapi/metaapi-javascript-sdk
- Cloud **MetaTrader 4 + 5** REST/WebSocket API with **both a Python and a browser/Node SDK** — one client against any MT broker account.
- Runtime: **Python *and* Node** (the only strong dual-runtime multi-broker option in this lane). Broker coverage: any MT4/MT5 broker via credentials → **multi-broker**.
- Places real orders: yes (trade endpoints). Maintained (2026-05).
- Evidence: *"Browser and node.js javascript SDK for MetaApi, a professional cloud forex trading API for MetaTrader platform which supports both MetaTrader 5 and MetaTrader 4. Free usage tier available."* (topics: `mt4-api`, `mt5-api`, `forex`, `rest`, `websocket`)
- Practical: **the practical answer to "Node + multi-broker forex"** — a hosted bridge so a Node/Python bot can trade any MT broker without running a terminal. Caveat: it is a **commercial cloud** with a free tier (your account creds go to MetaApi), not self-hosted open infra.

## 5. Ichinga-Samuel/aiomql
- Stars **150** · Python · Last push **2026-07-26** · Archived no · License n/a
- https://github.com/Ichinga-Samuel/aiomql
- Async Python framework for building **MT5 forex bots** (strategy base classes, sessions, order helpers) on top of the official `MetaTrader5` package.
- Runtime: Python. Broker coverage: MT5 → any MT5 broker → **multi-broker (within MT5)**.
- Places real orders: yes. Actively maintained.
- Evidence: *"Asynchronous Python Library For MetaTrader 5"* (topics: `forex-bot`, `forex-trading`, `metatrader5`, `trading-bot`).
- Practical: the closest thing to a maintained **Python "forex-bot framework"** rather than a one-file script; good scaffolding, small community.

## 6. trentstauff/FXBot
- Stars **313** · Python · Last push **2025-06-01** · Archived no · License n/a
- https://github.com/trentstauff/FXBot
- Fully automated **Forex bot on the OANDA API** (v20) with a built-in ML signal path and strategy plumbing.
- Runtime: Python. Broker coverage: **OANDA only** → **single-broker**.
- Places real orders: yes. Maintained (2025).
- Evidence: *"A fully automated Forex trading bot utilizing the OANDA API."* (topics: `forex`, `oanda-api-v20`, `machine-learning`, `trading-bot`)
- Practical: the best-maintained *pure retail forex* Python bot, great reference architecture — but not multi-broker; porting means rewriting the broker layer.

## 7. kieran-mackle/AutoTrader
- Stars **1272** · Python · Last push **2025-05-04** · **Archived yes** · License n/a
- https://github.com/kieran-mackle/AutoTrader
- Python platform: backtest → optimise → live, with a **forex/OANDA** focus plus broker/exchange adapters (topics include `crypto`, `stocks`).
- Runtime: Python. Broker coverage: OANDA (forex) + others via adapters → **partially multi-broker**.
- Places real orders: yes. **Now archived** (read-only, still installable).
- Evidence: *"A Python-based development platform for automated trading systems - from backtesting to optimisation to livetrading."* (topics: `forex`, `oanda`, `trading-platform`)
- Practical: excellent, well-documented Forex-first framework used by many tutorials; frozen — fine to fork, won't get fixes.

## 8. unageanu/jiji2
- Stars **249** · **JavaScript (Node)** · Last push **2021-04-30** · Archived no · License n/a
- https://github.com/unageanu/jiji2
- Node/JS **forex algorithmic-trading framework** on the **OANDA REST API** (streaming rates, indicators, backtest, simulator).
- Runtime: **Node/JavaScript** — the flagship *Node* forex bot framework. Broker coverage: **OANDA only** → single-broker.
- Places real orders: yes. **Unmaintained since 2021.**
- Evidence: *"Forex algorithmic trading framework using OANDA REST API."* (topics: `forex`, `trading-robots`) — note topics mis-tag `ruby`.
- Practical: still the reference for **Node forex botting**; expect to refresh the OANDA v20 calls. Node is otherwise near-empty for real FX bots.

## 9. fintechees/Expert-Advisor-Studio
- Stars **359** · **JavaScript** · Last push **2026-09-17** · Archived no · License n/a
- https://github.com/fintechees/Expert-Advisor-Studio
- JS/Node + browser **EA studio**: expert advisors, code generator, market-maker bot, **FIX API**, MetaTrader, Binance API, free forex/crypto history plugins.
- Runtime: **JavaScript/Node (+ browser)**. Broker coverage: **FIX API + MT + Binance** → multi-venue.
- Places real orders: yes (via generated EAs / FIX). Maintained (2026-09).
- Evidence: *"Expert Advisors, Browser-based EA, Free Crypto / Forex Historical DATA API plugins, EA Codes Generator, Market Maker Bot … Binance API, FIX API related."* (topics: `fix-api`, `expert-advisor`, `forex`, `trading-robot`)
- Practical: the most active **Node/JS multi-venue FX tooling** found — but it reads as a product ecosystem ("Fintechee means…"), so audit before trusting the generated code.

## 10. jimtin/algorithmic_trading_bot
- Stars **162** · Python · Last push **2025-04-09** · Archived no · License n/a
- https://github.com/jimtin/algorithmic_trading_bot
- Python bot that **integrates MetaTrader 5 *and* Binance** (MACD example), i.e. an FX broker + a crypto exchange in one process.
- Runtime: Python. Broker coverage: **MT5 + Binance** → **multi-venue** (one FX venue).
- Places real orders: yes. Maintained (2025).
- Evidence: *"Python Trading Bot for Algorithmic Trading. Integrates with MetaTrader 5, Binance."* (topics: `metatrader-5`, `binance`, `trading-bot`)
- Practical: small, readable template for a **two-venue** Python bot; good starting skeleton, thin strategy depth.

## 11. ogunjobiFX/MT4-MT5-Forex-Signal-Copier-Telegram-Bot
- Stars **254** · Python · Last push **2024-09-23** · **Archived yes** · License n/a
- https://github.com/ogunjobiFX/MT4-MT5-Forex-Signal-Copier-Telegram-Bot
- Telegram bot that copies/enters signals **directly into MT4 & MT5 accounts** (via **MetaApi**), with lot sizing and P/L display.
- Runtime: Python. Broker coverage: **MT4 + MT5 via MetaApi** → broker-agnostic → multi-broker.
- Places real orders: yes. **Archived** (2024).
- Evidence: *"Telegram bot used for copying and entering signals from signal provider directly to MT4 and MT5 trading accounts with calculated lot sizes and profit/loss display."* (topics: `metaapi-cloud`, `copytrade`, `mt4`, `mt5`)
- Practical: the canonical **Telegram-signal → multi-broker MT exec** pattern, and it shows the MetaApi route concretely; frozen and unmaintained.

## 12. spotware/OpenApiPy
- Stars **193** · Python · Last push **2024-08-07** · Archived no · License n/a
- https://github.com/spotware/OpenApiPy
- Official Python client for the **cTrader Open API** (protobuf/async) — the entry point to the cTrader broker network.
- Runtime: Python. Broker coverage: **all cTrader brokers** → **multi-broker by protocol**.
- Places real orders: yes (library, you write the bot). Semi-maintained.
- Evidence: *"A Python package for interacting with cTrader Open API"* (family: `cTraderFixPy`, `OpenAPI.Net`, `ctrader-algo-samples`).
- Practical: the **FIX/Open-API alternative to MetaTrader** for multi-broker FX in Python; a library, not a bot — add your own strategy. Same family: `spotware/cTraderFixPy` (64★, FIX API), `ejtraderLabs/ejtraderCT` (80★, "Python Ctrader FIX API … for HFT").

---

## Multi-broker reality check (for the reducer)
- **Genuinely multi-broker + maintained:** `lumibot` (12 brokers), `metaapi` SDKs (any MT broker, Python+Node), `aiomql`/`PyTrader` (any MT broker), `OpenApiPy` (any cTrader broker).
- **Multi-venue but stalled/archived:** `blankly` (2024-12), `AutoTrader` (archived), signal-copier (archived).
- **Single-broker but solid:** `FXBot` (OANDA), `jiji2` (OANDA, Node), `26medias/bot-lazy-trader` (OANDA, Node, MIT).
- **Node/JS:** only ~22 repos total and almost none are multi-broker bots — `jiji2` (OANDA), `26medias/bot-lazy-trader` (OANDA), `fintechees` (FIX/MT/Binance), `metaapi-javascript-sdk` (any MT broker, cloud), `PenguinTraders/MT4-Node.js` (MT4 bridge, 135★, 2014), `spotware/ctrader-telegram-bot` (13★, 2016). Everything else JS is data/backtest, not an order-placing FX bot.

## Also seen (real, but lower value / adjacent / non-Python-Node)
- **mhallsmoore/qsforex** — 859★, Python, 2022: QuantStart's OANDA backtest→live Forex framework (tutorial-grade, unmaintained).
- **darwinex/dwx-zeromq-connector** — 374★, Python, 2022: "any language → Darwinex liquidity via a ZeroMQ MetaTrader bridge EA" (broker-agnostic bridge pattern; see also `dw xconnect`, `dwx-fix-connector`).
- **Joaopeuko/Mql5-Python-Integration** — 213★, Python, 2025-12: write EAs in Python, drive MQL5 (topics `metatrader5`, `mql5-python`).
- **khramkov/Backtrader-MQL5-API** — 299★, Python, 2021: Backtrader ↔ MQL5 (backtest/send orders).
- **ariadng/metatrader-mcp-server** 815★ and **Qoyyuum/mcp-metatrader5-server** 227★, Python, 2026: let an LLM place MT trades (MCP) — the "AI bot" route to any MT broker.
- **Leo4815162342/dukascopy-node** — 919★, TypeScript, 2026-07: download historical/real-time **forex/crypto tick data** from Node (data, not a bot — but the best Node FX plumbing).
- **rosemarycox5334-debug/AlphaMaster** — 615★, Python, 2026-09: "MT5 factor mining, backtest, web UI" (no topics; verify).
- **jimtin/how_to_build_a_metatrader5_trading_bot_expert_advisor** — 180★, Python, 2025: tutorial companion.
- **Mo-Khalifa96/Forex-Trading-Bot** 65★ / **Jessika-Art/Trading-Bot-MT5-Forex** 49★ / **ryu878/MT5-python-bot** 50★ / **chrisnov-it/quantumbotx** 23★ / **VoxHash/ForexSmartBot** 22★ / **toki-plus/ai-trader-for-mt4** 28★ — small Python MT5/MT4 bots; usable as templates.
- **2023ai/ftmo-risk-control** — 94★, Python, 2026-08: MT5/cTrader adapters for prop-firm risk gates (risk layer, not a bot). **maghdam/chatgpt-trading-strategy-assistant** — 41★, Python, 2026-09: FastAPI + cTrader Open API LLM order placer.
- **hkopp/quantfxengine** 14★ (2015), **reuniware/CryptoForex-Trader-Framework** 32★, **henryzhongsc/half_tael_DQN** 32★ — historical Python FX-bot references.
- Non-Python/Node but directly on-topic: **sklinkert/at** (Go, 92★, 2026-07, "framework for building trading bots"), **Hallupa/AutomatedTrading** (C#, 22★, "FXCM/Binance trade bot designer"), **EA31337/EA31337** (C++/MQL, 1308★, multi-strategy MT4/MT5 robot), **StockSharp** (C#, 10825★), **QuantConnect/Lean** (C#/Python, 21852★), **nautechsystems/nautilus_trader** (Rust/Python, 29578★, multi-venue engine with FX adapters).

## AVOID (keyword-farm / lead-gen / hype — verify before trusting)
1. **The "≤130★ HTML" cluster** — ~15 repos all pushed **2026-10-03**, **HTML**, marketing titles + heavy topic-stuffing, e.g. `youcefito/mt5-quiet-automata` (127), `AbdulWasay13/TradingView-Pipe-Executor` (127), `ajayprabhuraj/institutional-orderflow-mt5` (124), `youcefbibo53/PropGuard-Trailing-Equity-Armor` (123), `Wendy-Bay/PropFirm-Tracker-Elite` (119), `dbgucci1017/MT5-Equity-Guardian-Trailing-Pro` (119), `Syed-Imran88/MT5-Exposure-Mesh-Analyzer` (118), `Dream-XR/MT5-Post-Trade-Insight-Reporter` (118), `peridotfoundation/MT5-Directional-Flow-Dashboard` (116), `bipbopcompany-droid/Risk-Nexus-Command` (116), `Aloni-zin/Equity-Ray-Tracer` (116), `tharindu2028/Trade-Terminator-Closer` (115). Uniform star band + "Best … 2026" phrasing + no code = SEO/lead-gen landing repos, not bots.
2. **KamranAliOfficial/forex-ea-mt5-robotic-trading** — 39★: *"A premium collection … Includes scalping bots, AI-based EAs"* — free-listing funnel toward paid EAs.
3. **zhutoutoutousan/profitable-expert-advisor** — 47★: *"Profitable MT5 Expert Advisors"* (profit claim in the repo name).
4. **Minhtan2005/-Professional-automated-gold-trading-bot…MT5-XAUUSD-** — 23★: *"…Standard Free Edition"* — open core + paid upsell; "professional/profitable" claim.
5. **simoncampos1022/profitable-futures-trading-strategy-crypto-forex-stock** — 21★, HTML, "profitable … strategy" keyword-stuffed (topics list Binance/Bitget/Blofin/Bybit/MT4/MT5/TradeStation).
6. **BlackRichGuy/Deriv-Trading-Bot** — 21★, no language: *"Free Deriv Trading Bots, Binary Bot strategy, DBot and Ultimate Analysistool 2026"* — keyword-farm.
7. **Opselon/** cluster — `Opselon/ForexTradingBot` (47★, C#) & `Opselon/NexusTradingForexBot` (19★, Python): "👑 Enterprise-grade … AI-driven Telegram signals" hype naming, new, unproven.
8. **Sfedfcv/redesigned-pancake** (268★) and **pxvr-official/1** (531★) — mislabeled/junk repos surfaced by the FX queries (the latter is unrelated spam); ignore.
9. Minor caution: **Minhtan2005**, **triqbit/mt5-ai-xauusd-trader** (154★, 2026-10-03) and **zero-was-here/tradingbot** (200★) advertise "merged from 25+ repos / AI gold bot" with heavy claims and no topics — promising but unaudited.

---

**Lane verdict (forex-bot / Python-Node / multi-broker):** For a solo user the lane resolves to three actionable picks — **`Lumiwealth/lumibot`** (Python, maintained, 12 brokers, forex-capable), **`TheSnowGuru/PyTrader`** (Python ↔ any MT4/MT5 broker, live+paper) and the **`metaapi` Python+Node SDKs** (the only credible *Node* multi-broker FX path, cloud-hosted). Direct open-source **multi-broker Node forex bots are essentially absent**; the Node side is `jiji2`/`bot-lazy-trader` (OANDA-only, 2021) plus bridges. The category is also the most heavily keyword-farmed part of the ecosystem (see AVOID #1–#2), so star counts here should not be read as quality.