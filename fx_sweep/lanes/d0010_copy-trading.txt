# Forex Copy Trading & Signal Services — Open-Source Survey

**Lane:** `copy-trading` · **Keyword:** "forex copy trading" · **Focus:** Copy trading and signal services · Run `wf_71a518c957daaf7c` (script `.myterminal/workflows/saved/mtfx.js`), 2026-10-04.

## Method and a hard caveat (read first)

This path is **read-only and network-blocked at the tool layer**. I confirmed it against the source, not by guesswork: `src/workflows/tool-command.ts` exports `SAFE_READ_COMMANDS` as the entire read face — `ls cat head tail wc grep rg find pwd echo printf sort uniq cut tr diff cmp du df stat file basename dirname realpath readlink which whoami date tree jq sed(-i denied) git(status|log|diff|show|branch|rev-parse|ls-files|blame|describe|remote) node --version bun --version npm(ls|--version)`. Everything else — `curl`, `wget`, `gh`, `git ls-remote`, `nc`, `openssl`, `ping`, `python3`, `node -e`, `bun -e` — returns `not-in-read-only-allowlist`. There is **no network egress on this path**, so the GitHub Search/Repo API pipeline that produced `gh_search/` and `verify2/` could not run.

A repo-wide grep for `forex|mt4|mt5|metatrader|copytrad|mql5|signal` finds **no forex/copy-trading corpus on disk**. The only prior-research artifacts here (`gh_search/`, `verify2/`, `gem-research/`, `.scratch/airdrop_research/`) are the sibling **CEX-listing-sniper** lane. There is exactly **one** local file that touches this lane's keyword space — `gh_search/readmes2/coffellas-cto_Solana-Copy-Trading-Bot.md` (with metadata in `extra_meta.txt`) — and it is a **Solana/crypto** copy bot, i.e. a keyword collision, quoted in §5.

What follows is therefore a **curator's map from domain knowledge, not an API-verified repo survey**. Repo *identities* are high-confidence; **stars/forks/license/last-push are deliberately omitted rather than invented**, and each named repo is tagged *needs live re-verification*. The structural findings (§1, §6) and the risk section are the parts I would stand behind. The sibling lanes `mt5-ea`, `mt4-ea`, `mt5-lib`, `mt5-bot`, `forex-backtest` hit the same wall and returned the same shape of result.

---

## 1. How this lane is actually shaped (framing)

Four structural facts govern every finding. Miss them and the lane looks like "a category with a few missing repos"; get them and it looks like a **one-sided market**.

1. **"Copy trading" is three different products that the keyword conflates.**
   - **(a) Broker/platform/server-side copy** — the platform hosts the pipe. MetaTrader's is **MQL5 Signals** (`mql5.com/en/signals`): closed, broker-hosted, built into the terminal. It is the *free default* most retail users actually use, and the only one with distribution.
   - **(b) MT4/MT5↔MT4/MT5 trade-copier EAs** — a master EA emits, a slave EA executes, relayed over **terminal global variables, files, named pipes, TCP/ZeroMQ, or a manager/agent server**. There is no official cross-account protocol; every implementation invents its own transport.
   - **(c) MT5↔external-process bridges** — an EA acts as an RPC/socket server so **Python/Node/.NET** can read the terminal and place orders, and an outside program does the mirroring/allocating. *This is the only half where genuinely reusable open source lives*, and it overlaps the `broker-api`, `mt5-bot` and `tradingview` lanes.
2. **MetaQuotes ships no open copy API.** The official `MetaTrader5` Python package drives a *running terminal* over local IPC (Windows-only, closed freeware); it does not provide cross-account copy. Anyone building a copier builds the transfer layer themselves or buys it.
3. **"Signal services" splits in two, and only the weak half is open.**
   - **In-platform social/copy** (MQL5 Signals, ZuluTrade, Myfxbook Autotrade, cMirror/cTrader, Darwinex, eToro, Collective2) — all **closed**, regulated-as-they-choose, and the ones with real liquidity.
   - **Messaging relays** (Telegram/WhatsApp/Discord signal → parse → `order_send`) — many small one-author GitHub scripts, unpolished, no reconciliation. This is where the lane's open-source "signal services" are, and they are the *front half* of a pipe whose *back half* is the `mt5-bot` lane.
4. **The lane is a compliance magnet.** Copying/mirroring client trades and selling signals are regulated activities (MiFID/CFTC/ASIC etc.); the open-source and commercial surface is saturated with affiliate funnels, "VIP signal" Telegram rooms, and martingale signal sellers. That is not a side note — it *is* the dominant shape of the lane's long tail.

**Consequence for the umbrella report:** the honest one-line finding is the mirror image of the CEX lane. There, the alpha was arbitraged away and the repos were abandoned. Here, **the turnkey product is closed and commercial by design (brokers/platforms own it), the open source is a thin, DIY bridge layer plus unpolished relays, and the "free copy bot" long tail is mostly affiliate scams.** The reusable gold is in §2; the "profit" claims are in §6's avoid list.

---

## 2. Core open building blocks (what you'd actually build a copier on)

*(Identities high-confidence · metadata unverified · cross-lane: `broker-api`, `mt5-bot`)*

- **`darwinex/dwx-zeromq-connector`** ("DWX Connect") — MQL4/MQL5 **EA + native/.NET/Python clients over ZeroMQ**: ticks, bars, order send/close, symbol info. The canonical open route to drive a terminal from Python. License MIT/GPL-family (verify exact tag; it changed across the MT4→MT5 era). **This is the single most important open piece for the lane** — the substrate under any *open* copier. *needs re-verification.*
- **`dingmaotu/mql-zmq`, `mql-http`, `mql-redis`, `mql-sqlite3`, `mql4-lib`, `mql5-lib`** — native DLL bindings so an EA speaks ZeroMQ/HTTP/Redis/SQLite directly (per-capability instead of whole-terminal). Apache-2.0-family (verify). Topology-of-choice for master/slave copiers that need low-latency cross-process state.
- **`vdemydiuk/mtapi` (MtApi / MtApi5)** — MQL **EA + named-pipe server + .NET/Java client**, REST/JSON façade. The .NET-native alternative to DWX. Apache-family (verify); low activity.
- **MetaQuotes `MetaTrader5` Python package** — the de-facto substrate (free, **closed**, Windows-only). Not a copier; every "MT5 signal executor" quietly depends on it. *(Cross-ref `broker-api` — that lane owns it.)*
- **`mt5linux`** (PyPI) — RPyC shim to run that package from Linux against Wine MT5; the usual way to headless a copier on a VPS. *Verify owner/maintenance.*
- **MetaApi client SDKs** — `agiliumtrade-ai/metaapi-node.js-sdk` and the Python equivalent are **open-source clients for a closed, paid cloud** that brokers MT4/MT5 over REST/WebSocket. Relevant because "signal→MT4 on a Linux server" is usually solved by renting this rather than self-hosting Wine. Open SDK ≠ open service; say so. *(Cross-ref `broker-api`.)*
- **`EA31337/EA31337`** — a full open MQL EA framework usable as the *execution engine* a copier/relay commands. *(Cross-ref `mt5-ea`/`mt4-ea` — split once, don't re-list.)*

---

## 3. Open-source MT4/MT5 trade copiers (the direct subject) — thin, and honest about it

There is **no well-known, maintained, licensed, open-source MT4/MT5 account-to-account copier**. What exists:

- **A long tail of single-author MQL master/slave EAs** — relay via terminal global variables or shared files; typically **no `LICENSE`**, no symbol-suffix/prefix handling, no volume-scaling, no hedging-vs-netting awareness, no `OnTradeTransaction` deal detection, no partial-fill/slippage logic. Runnable on a demo; unsafe to trust with real allocation. Search by *file pattern* (`TradeCopier`, `CopyTrades`, `OnTradeTransaction`, `GlobalVariableSet`) — this layer is defined by copied `.mqh`, not by repo names.
- **Free-but-closed baseline: FX Blue Personal Trade Copier** (MT4/MT5) — the de-facto free answer; **closed**. Name it so the "open source" gap stays truthful.
- **Free-source-but-off-GitHub: EarnForex trade copier / utility scripts** — MQL source published on earnforex.com, not GitHub.
- **Commercial tier (closed):** Local Trade Copier, Trade Copier (by "EarnForex"/"4xDevs"-style vendors), TSCopyTrader, CopyMaster, SocialTraderTools, MultiTrading; plus paid **signal-sender/receiver EAs on the MQL5 Market**.

**The lane's gap statement is the copier correctness checklist itself:** symbol suffix/prefix mapping, volume scaling by equity/balance/risk, **hedging vs netting** account mode, partial fills and `DEAL_ENTRY`/`DEAL_TYPE` decomposition, fill/slippage reconciliation, prop-firm/FIFO/algo-trading restrictions, and reconnection/state recovery. No open repo is known to get all of these right; that is why users fall back to closed freeware or paid tools.

---

## 4. Signal services & social trading

*(The half of the focus that is mostly closed; open source is the relay plumbing.)*

| Kind | Representative | Open? | Note |
|---|---|---|---|
| Broker/server copy | **MQL5 Signals** (built into MT5) | Closed | The free default; subscriber history is exposed and **gameable** (short-history, martingale) |
| Social/copy platform | ZuluTrade, cMirror (cTrader), Myfxbook Autotrade, Darwinex, eToro, Collective2 | Closed | The real liquidity; none is OSS |
| Signal **relay** (messaging→broker) | small `telethon`/`pyrogram`/`python-telegram-bot`→`order_send` scripts | Open, unpolished | **Cross-lane: `mt5-bot` owns this — do not double-count** |
| Signal **relay** (webhook→broker) | `TBXark/TradingView-Webhook-Bot`-class relays; Pine-alert→MT bridges | Open | **Cross-lane: `tradingview` lane owns this** |
| PAMM/MAM | broker-provided (MT4/MT5 manager-side) | Closed | Effectively no open implementation; allocation math lives server-side |
| Copy-friendly broker APIs | OANDA v20, FXCM ForexConnect, cTrader Open API | Open clients, closed service | Legit route *if* your copy source is API-native, not MT4 *(cross-ref `broker-api`)* |

**Structural finding:** in this lane the *signal source* and the *account link* are almost always proprietary (platform-, broker-, or vendor-hosted). Open source contributes the **transport** (ZeroMQ/Redis/HTTP/webhook), not the **service**. An "open-source forex copy-trading platform" in the ZuluTrade sense does not exist to my knowledge; anyone claiming one should be verified against real order routing, not screenshots.

---

## 5. Keyword collisions — "copy trading" hits are mostly crypto, not forex

This lane's search terms are heavily contaminated by **crypto copy-trading** bots, exactly mirroring the CEX lane's "sniping" contamination. Two concrete local artifacts:

- **`coffellas-cto/Solana-Copy-Trading-Bot`** — real local metadata (from `extra_meta.txt`): **411★ · 114 forks · Rust · pushed 2026-04-17 · license none**. README (`gh_search/readmes2/…`) is a Solana pump.fun/PumpSwap/Raydium **wallet-mirroring** bot ("Yellowstone gRPC → target-wallet tx → copy buy/sell", racing confirms via Jito/BloxRoute), with a Telegram contact. **It is a crypto DEX copy bot — not forex, not MT4/MT5** — and it is on the round's own `scam_candidates.txt` watchlist. Cite as a collision example only.
- **`mortdeus/solana-copy-sniper-mev-trading-bot`** — 4473★/435 forks (Rust, BSD-3), already flagged in the sibling `cex_listing_sniper_report.md` `AVOID` list as **star-farmed + heavy self-promotion / Telegram funnel**. Same keyword-stuffing pattern ("…Sniper Copy Trading Bot…"). Do **not** let its star count inflate any "forex copy trading" ranking.

**Rule for the reducer:** any high-star "copy trading" repo whose README links `solscan.io`, pump.fun, or a `SOLANA_PRIVATE_KEY` is **crypto** — exclude from a forex lane, or list once under crypto with a label. Real MT4/MT5 copiers will reference `MQL5`, `order_send`, `OnTradeTransaction`, or `MetaTrader5`.

---

## 6. AVOID / risk flags (high value to the umbrella report)

1. **"Send your (investor / master) password" copiers and signal tools** — this lane's signature scam. The **investor** password leaks live performance; the **master** password is *full account control* (withdrawal-capable at many brokers). Anything asking for either is a drain pattern; there is no legitimate open tool that needs your master password.
2. **"VIP copy-trading / signal" funnels** — keyword-stuffed README → Telegram/Discord → paid room or affiliate/IB referral link. Description promises "MT4/MT5 copy trading"; the code never calls `order_send`/`OrderSend`. Prove it by grepping the source for the real trade call.
3. **Compiled `.ex4`/`.ex5` with no source, and decompiled "source"** — the top **malware vector** in this ecosystem (info-stealers targeting terminal files, `config/`, credentials; DLL side-loading). Never run against a funded account.
4. **`curl | bash` "one-line copier installers"** and bundled DLLs — same class.
5. **Martingale/"recovery" signal sellers** — the MQL5 Signals and commercial-signal rating systems can both be gamed by short-history providers who risk little until they blow up followers; "verified 90% win-rate" screenshots without walk-forward/tick realism are not evidence.
6. **No `LICENSE` = all rights reserved.** Most repos in this lane ship none; "public repo" ≠ reusable. Several commercial copiers are *also* closed despite visible interface.
7. **Regulatory/latency reality** — copying a signal is not the same as copying a *fill*: slippage, spread widening, broker-time offsets, and per-broker symbol suffixes make "same trades, same results" false. Any claim of identical follower P&L is a red flag.

---

## 7. Queries to actually close this lane (run where network exists)

Record `stars/forks/license/created/pushed/archived/issues` from the Repo API exactly as the CEX lane did, then fetch READMEs.

`forex copy trading` · `mt4 trade copier` · `mt5 trade copier` · `metatrader trade copier` · `copy trading mql5` · `mql5 signal copier` · `signal copier mt4` · `metatrader5 signal` · `telegram signal to mt5` · `mt5 webhook signal` · `copy trading bridge` · `account copier forex` · `social trading open source` · `pamm mam open source` · `mt5 zeromq bridge`.

Then close the two real gaps explicitly: **(a) search by file, not name** — `GlobalVariableSet`, `OnTradeTransaction`, `OrderSend`, `CTrade`, `*.mqh`, `DWX`, since copiers are vendored headers; **(b) fetch the off-GitHub shelf separately** — `mql5.com/en/code` (CodeBase), `mql5.com/en/signals`, `mql5.com/en/market`, and earnforex.com tool pages. GitHub search cannot see where most MT4/MT5 copiers and signal tools actually live.

---

## 8. Handoff notes for the reducer

- **Shortlist (only items I'd promote):** `darwinex/dwx-zeromq-connector`; the `dingmaotu` binding family (`mql-zmq`/`mql-http`/`mql-redis`); `vdemydiuk/mtapi`; the MetaQuotes `MetaTrader5` package + `mt5linux`; MetaApi client SDKs (open client / closed service); and **MQL5 Signals / CodeBase / Market** as the off-GitHub shelf. Closed baselines to name for honesty: FX Blue Personal Trade Copier, Local Trade Copier, TSCopyTrader, ZuluTrade, Myfxbook Autotrade, cMirror, Darwinex, eToro.
- **Key correction to carry up:** **there is no open cross-account copy API in MetaTrader and no well-known OSS MT4/MT5 copier.** Open source here = *bridges + relays*, not the copy service. Do not present any repo as a turnkey copy-trading product without live verification of real order routing.
- **Cross-lane de-dup:** DWX / mtapi / mql-zmq / mt5linux / MetaApi ↔ **`broker-api`** and **`mt5-bot`**; Telegram/Discord signal relays ↔ **`mt5-bot`**; TradingView-webhook→broker relays ↔ **`tradingview`**; EA31337 execution engine ↔ **`mt5-ea`**/**`mt4-ea`**; crypto "copy trading" bots (§5) → **crypto lane, not this one** — list once with a label.
- **Coverage gap to close in a network-enabled pass:** this entire lane's metadata is unverified because the path has no network; it needs one API pass (`forex copy trading` + the file-pattern queries in §7) **plus** an MQL5 CodeBase/Signals fetch before any star counts or license claims are published.
- **Confidence:** structural findings (§1, §6) = **high**; named-repo identities = **high**, but all metadata (stars/forks/license/push) = **unverified / medium** on this path — **do not publish numeric stars for this lane from this report.**