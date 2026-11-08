# Lane `tradingview` — TradingView Webhook Bridges & Alert→Broker Relays
Lane: `tradingview` · keyword "tradingview webhook bridge" · focus: webhook relays and alert-to-broker bridges. Run `wf_71a518c957daaf7c` (script `.myterminal/workflows/saved/mtfx.js`), 2026-10-04.

## Provenance — read first (same wall as the sibling lanes)
This path is **read-only and network-blocked at the tool layer**. I confirmed the allowlist in-repo: `src/workflows/tool-command.ts` (`SAFE_READ_COMMANDS`) permits only `ls/cat/head/tail/wc/grep/rg/find/pwd/echo/printf/sort/uniq/cut/tr/diff/cmp/du/df/stat/file/basename/dirname/realpath/readlink/which/whoami/date/tree/jq/sed/git status|log|diff|show|branch|rev-parse|ls-files|blame|describe|remote/node --version/bun --version/npm ls`. `curl`, `wget`, `gh`, `nc`, `python3 -c`, `node -e` and any redirection are refused (`not-in-read-only-allowlist`), so **no live GitHub call was possible in this run**.

I grepped the whole working dir for `tradingview|webhook`. There is **no TradingView/forex corpus on disk** — the only hits are (a) the workflow script itself, and (b) incidental mentions inside the unrelated CEX-listing dumps (`gh_search/q16_volume_bot_crypto.json` → `DiegoLial/Crypto-Telegram-BOT`, which merely *says* "Tradingview pinescript"). So unlike `cex_listing_sniper_report.md`, this lane could **not** be populated from GitHub Search/Repo API responses.

What follows is a **knowledge-based curator's map, not an API-verified survey**. Repo identities carry confidence tags; **stars/forks/last-push/license are deliberately omitted rather than fabricated**. Structural findings and the risk section are what I'd stand behind. Sibling lanes `mt5-ea`, `mt4-ea`, `mt5-lib`, `mt5-bot` hit the identical wall and returned the same shape.

---

## 1. How this lane is shaped (framing)
Five structural facts govern every finding:

1. **TradingView has no order API and no alert-creation API.** The *only* programmatic egress is the **webhook**: on an alert fire, TradingView HTTP-POSTs whatever text you typed into the alert message box to a URL you supply. Alerts themselves must be created **by hand in the UI** — you cannot script alert creation. So a "bridge" always decomposes into **(a) a webhook receiver you host** + **(b) an order executor**.
2. **The TradingView-specific code is tiny.** There is **no standard payload schema** — the "message" is free text (usually hand-written JSON using placeholders like `{{ticker}}`, `{{exchange}}`, `{{close}}`, `{{volume}}`, `{{time}}`, `{{interval}}`, `{{strategy.order.action}}`, `{{strategy.order.contracts}}`, `{{strategy.order.price}}`, `{{strategy.order.alert_message}}`, `{{plot_0}}`). Every bridge invents its own field names. So the *TradingView half* is trivial (parse JSON + check a secret); the *hard half* is broker execution — which is exactly the MT4/MT5 problem the sibling `broker-api` / `mt5-bot` lanes already own.
3. **Consequence: this lane is thin on GitHub.** The catalogue is dominated by (i) small single-author receivers, (ii) generic chat relays, and (iii) re-branded copies of the same Flask/FastAPI snippet. There is no `freqtrade`-scale flagship.
4. **Webhooks are a paid-tier feature** and fire **best-effort** (not ordered, retried, droppable under burst). Plan-gating is real: free tiers get few/no webhooks. Anything promising "unlimited free TradingView webhooks" is a ToS violation or a funnel.
5. **Where it lands splits into two ecosystems:** crypto (ccxt) is where most OSS lives; **forex/MT4/MT5 is thin and DIY**, because MT has no open server API (the same wall the sibling lanes documented) — so the forex story is "webhook receiver → bridge EA / `MetaTrader5` pip", reusing the `broker-api` plumbing, not a rich shelf of TradingView↔MT5 repos.

---

## 2. The relay archetype (TradingView → chat/notification) — *existence: high*
This is the largest, healthiest cluster: receive the webhook, fan it out to humans. No order execution, so lowest risk.

| Project | Lang | What it is | Confidence |
|---|---|---|---|
| **`TBXark/TradingView-Webhook-Bot`** | Go | The reference alert relay: one binary receives a TradingView webhook and forwards to Telegram / Slack / Discord / DingTalk / Feishu(Lark) / WeCom, config via env/`config.yml`; license MIT-ish | **high** (identity) / medium (license) |
| **`robswc/tradingview-webhooks`** | Node | Minimal Node webhook receiver for TradingView alerts (parse + dispatch) | medium |
| **`huginn/huginn`** | Ruby | General self-hosted "agents" engine with a Webhook agent + HTTP agent — you wire TradingView→Huginn→broker HTTP | **high** |
| **`n8n-io/n8n`** | TS | Self-hosted workflow automation; Webhook trigger → HTTP Request node = a no-code TradingView→broker relay | **high** |

These are the safest starting point and the "front half" of any signal→broker pipe. `TBXark` and `huginn`/`n8n` are the two I'd actually name as reusable.

---

## 3. The "alert → broker" execution half (the lane's real focus) — *existence: high, mostly DIY*

### 3.1 MT4/MT5 (forex) — reuses the `broker-api` substrate, no TradingView-specific flagship
There is **no notable open "TradingView→MT5" repo**; there are hundreds of near-identical one-off receivers. The credible pattern is: **TradingView webhook → your Python server → `MetaTrader5` pip `order_send()`** against a running terminal, or **→ a bridge EA**. The reusable, real components:

- **`darwinex/dwx-zeromq-connector`** (DWX Connect) — *high confidence.* MQL5 EA + Python/C++ client exposing MT4/MT5 over **ZeroMQ** (ticks, bars, order send/close). The canonical headless-control bridge; pair it with a webhook receiver to get TradingView→MT5. **Not TradingView-specific** — the exec half.
- **`vdemydiuk/mtapi` / `mtapi5`** — *medium-high.* MQL EA + named-pipe server + .NET/Java client with a REST/JSON façade; low activity.
- **`dingmaotu/mql-http`** + **`mql-zmq`** + **`mql-redis`** — *medium-high.* MQL HTTP **client/server** and ZeroMQ/Redis bindings so an EA can *be* the webhook endpoint or poll one — the "EA polls a webhook inbox" pattern (MQL's `WebRequest()` only calls *out*; `mql-http` adds the server side).
- **Official `MetaTrader5` Python package** (free, closed, **Windows-only**, local-IPC) — the substrate under almost every DIY webhook→MT5 script. **Cross-lane:** `broker-api`.
- **`EA31337/EA31337`** — *high confidence.* Substantial open MT4/MT5 EA you can drive as the execution engine. **Cross-lane:** `mt5-ea`.

### 3.2 Real forex/CFD REST brokers (have APIs ⇒ open bridges exist)
Where the broker exposes a clean REST/FIX API, a webhook receiver is a weekend project and several open starters circulate:

- **OANDA v20** — **`oandapyV20`** (*high confidence*) is the library; `tradingview-webhook-oanda`-style receivers are common.
- **Alpaca** — **`alpacahq/alpaca-trade-api-python`** (now `alpaca-py`); TradingView-webhook starters exist.
- **Interactive Brokers** — **`ib_insync`** (*high confidence*); webhook starters exist but IBKR's gateway/session model makes them brittle.
- **cTrader** — **`spotware/OpenAPI`** (cTrader Open API); the polished bridges here are **commercial** (TradingConnector, Autoview), not OSS.

### 3.3 Crypto (adjacent — label as another lane, do not double-count)
Most volume of "TradingView webhook bot" repos is crypto: webhook → **ccxt** → Binance/Bybit/OKX. Also **`freqtrade`**'s REST/webhook endpoint can be a TradingView target (*medium confidence* on the exact endpoint), and `jesse-ai/jesse` has webhook/alert plumbing (*medium*). These belong to the crypto lane; list once.

---

## 4. Closed baselines to name honestly (so the "open source" gap is truthful)
- **TradingView native broker connections** (OANDA, Capital.com, FXCM, Tradovate, …) — the official, in-UI "alert→broker" path; **closed**, and not webhook-based.
- **Pineconnector** (*high confidence*) — the de-facto *paid* TradingView→**MT4/MT5** bridge (licensed EA + relay). If a user says "TradingView to MT5", this is usually what they mean; it is **not** OSS.
- Other commercial relays: **Autoview** (Chrome extension; crypto + some brokers), **Alertatron**, **Cornix**, **3Commas**, **WunderTrading**, **TradingConnector**, **Capitalise.ai**, **MetaApi** (cloud MT bridge).
- **Webhook Relay** (webhookrelay.com) and **ngrok** — commercial/tunnel plumbing for exposing a local receiver.

---

## 5. Where open source is weak (the lane's real finding)
- **No maintained, general-purpose OSS "TradingView→broker" framework.** The category is a long tail of small receivers, not a product.
- **No standard payload contract** → zero interop; every repo re-invents the field names.
- **Forex/MT4/MT5 specifically is the thinnest slice**: it inherits MT's "no open server API" problem, so the honest answer is "roll your own with `dwx`/`MetaTrader5` + a webhook receiver", not "clone repo X".
- **Alert management can't be automated** (UI-only alert creation) — a structural ceiling no OSS can lift.

---

## 6. Risk / AVOID flags
1. **Unauthenticated webhook endpoints that place live orders.** The URL is the only secret TradingView sends; a receiver with no shared-secret/HMAC + no IP allowlist is a public "trade my account" button. Common in tutorials.
2. **Secrets committed in READMEs/`.env` examples** (broker keys, webhook passphrase) — copy-paste keys get drained.
3. **`.ex4`/`.ex5`-only "TradingView webhook EA" drops** with no source — the #1 malware vector in the MT ecosystem (info-stealers, terminal-credential theft); sibling lanes flagged the same. Never run precompiled.
4. **Compiled-EA / `curl|bash` "one-line installers"** and EA/DLL installers — same malware channel.
5. **Tools asking for the MT4/MT5 master (or investor) password**, or "manager" credentials, to "connect your broker" — full account control / performance leak.
6. **"Unlimited free TradingView webhooks" / cracked-plan** claims — plan-gating is real; this is a funnel or a ToS violation.
7. **Telegram-funnel "AI TradingView→MT5 bot"** repos — keyword-stuffed README, code never touches the broker. Same pattern as the CEX lane's `AVOID` list.
8. **Keyword collision:** many "tradingview" hits are **Pine→MQL indicator ports**, not webhook bridges — that's the `mt5-indicator` lane's territory. Filter on a real HTTP receiver / `WebRequest`/`HTTP` call.

---

## 7. Handoff notes for the reducer
- **Shortlist (only items I'd promote):** `TBXark/TradingView-Webhook-Bot` (relay archetype); `huginn/huginn` or `n8n` (self-hosted relay plumbing); for execution — `darwinex/dwx-zeromq-connector`, `dingmaotu/mql-http`+`mql-zmq`, official `MetaTrader5` pip, `EA31337` (forex/MT); `oandapyV20` / `alpaca-py` / `ib_insync` (REST-broker). Name **Pineconnector / Autoview / MetaApi** as the closed baselines.
- **De-duplicate:** exec half ↔ `broker-api`, `mt5-bot`, `copy-trading`; Pine→MQL ports ↔ `mt5-indicator`, `price-action`; execution EAs ↔ `mt5-ea`; crypto webhook bots ↔ the crypto lane. The **TradingView-specific** contribution is the webhook contract + receiver + auth, not the order path.
- **Coverage gap to close in a network-enabled pass:** queries `tradingview webhook`, `tradingview webhook bot`, `tradingview webhook mt5`, `tradingview webhook mt4`, `tradingview alert to broker`, `tradingview webhook fastapi|flask`, `tradingview to oanda|alpaca|interactive brokers|ctrader`, `tradingview webhook ccxt`; code search `extension:mq5 webhook`, `extension:mq4 WebRequest`, `alert_message`, `{{strategy.order.alert_message}}`; and record stars/forks/license/last-push from the Repo API + READMEs like the CEX lane did.
- **Verification status:** structural findings + risk list = high; **the named-repo list = medium/unverified** (no API access on this path) and must be re-checked before it is merged as fact. **Do not publish star/fork/date numbers for this lane from this report.**