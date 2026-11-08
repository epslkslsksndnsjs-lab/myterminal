# CEX New-Listing Sniper Bots — Verified Report

**Date:** 2026-10-03 (UTC) · **Scope:** public GitHub repos that detect a token being **newly listed on a centralized exchange (CEX)** and either alert or trade it.

## Verdict

**No — there is no maintained, ready-to-run CEX new-listing sniper today.** Every CEX-focused repo that genuinely does listing-sniping is either abandoned (last push 2020–2024), a server-side placeholder, a closed-source paid binary, or a template/example. The high-star, actively-maintained snipers in this keyword space are all **Solana meme / on-chain DEX** bots — a different problem (watch the chain, not an exchange announcement) — and the only repos still above ~1000 stars are either those DEX bots or one keyword-stuffed farm repo. The core alpha (Binance listing pumps) has been arbitraged away; the leading open-source author (duckdegen) says so explicitly.

## Verification method & honesty note

- During **this run** I re-fetched `GET https://api.github.com/repos/<full_name>` (curl, `User-Agent` header) for a 28-repo list. **12 returned HTTP 200 and are live-verified below.**
- After the 12th call the shared egress IP **13.215.26.99** hit GitHub's unauthenticated core limit (60/hr); every later call returned `403 API rate limit exceeded`, reset ≈ 46 min out. I did **not** wait it out and I did **not** invent numbers.
- Rows not re-verified this run are labelled **"prior-run API"** and come from `gh_search/meta.tsv` (the previous subagent's `GET /repos` dump). **All 12 repos that overlap between the two runs matched exactly** on stars/forks/language/pushed/license/size — so the prior-run cache is corroborated, but the 403 rows were not independently re-confirmed today.
- README quotes are from the already-downloaded files in `gh_search/readmes/` and `readmes2/`. Where no README was downloaded, the quote is the repo **description** field from the API dump.
- Raw API JSON for the 12 verified repos: `/Users/Admin/myterminal/verify2/*.json`; request log: `/Users/Admin/myterminal/verify2/verify.log`.

**Key distinction used throughout:** **ALERT-ONLY** = notifies you (Telegram/Discord/webhook), places no orders. **AUTO-TRADE** = places real orders with your API keys.

---

## Table 1 — WORTH A LOOK

Real listing-sniper code; runnable in principle (stale but a sane starting point).

| full_name | ★ | forks | lang | last push | license | target | mode | README evidence | exchange API still exists? |
|---|---|---|---|---|---|---|---|---|---|
| **CyberPunkMetalHead/binance-trading-bot-new-coins** (live) | 1503 | 269 | Python | 2021-10-21 | MIT | Binance | **AUTO-TRADE** | *"This Binance trading bot detects new coins as soon as they are listed on the Binance exchange and automatically places sell and buy orders."* | **Yes.** Binance REST/WS + ccxt exist; caveat: 2021 ccxt/`python-binance` call signatures drifted, and the author later moved the "new coins" feature to a paid bot. |
| **duckdegen/apebot** (live) | 1506 | 471 | TypeScript | 2023-06-15 | MIT | Binance (announce) → DEX buy → Binance sell | **AUTO-TRADE** (hybrid) | *"Once a new token listing is detected … we go and aggressively buy it by using 0x API, using an EIP-1559 TX."* | **Partly.** Binance & 0x exist but 0x API v1 was sunset; author declared the edge gone: *"the alpha is public and the edge is gone."* Best-engineered repo in the set. |
| **CyberPunkMetalHead/new-listings-trading-bot** (live) | 99 | 28 | C# | 2025-01-30 | none | Binance announce → Poloniex buy | **AUTO-TRADE** | *"…detect new coin listing announcements on Binance and immediately purchase the announced coin on a different exchange (currently configured to Poloniex)."* | **Yes (weak).** Binance announcement + Poloniex REST exist, but Poloniex liquidity is tiny. Repo created & pushed the same day — a one-shot upload, no maintenance since. |
| **rickstaa/crypto-listings-sniper** (live) | 13 | 6 | Go | 2024-12-12 | none | Binance (multi-CEX historically) | **ALERT-ONLY** | *"A small bot that watches exchanges for new coin/token listings and, in less than 0.3 seconds, posts a Telegram/Discord message."* | **Yes** for Binance; the author removed the other venues (FTX/KuCoin/Gate/etc.) after Binance withdrew from the Dutch market. Cleanest alert scaffold. |
| **d1-dblaze/CEX-snipers** (live) | 3 | 2 | Python | 2023-12-25 | none | several CEXes | **AUTO-TRADE** | *(no README downloaded; API description)* *"This repo contains several CEXes snipping bot that spot buys a token once listed for a quick X % before closing the trade."* | **Yes** for the majors it targets; no docs, no license, unverified. |
| **everydaycodings/Binance-Listing-Bot** (prior-run API) | 8 | 0 | Python | 2022-01-29 | none | Binance | **AUTO-TRADE** | *"Binance-Listing-Bot (Sniper Bot) — to place an order as soon as an Asset is listed on Binance."* | **Yes** (Binance; `python-binance`). Simple/dated. |
| **georgGrankvist/CoinbaseListingSniper** (prior-run API) | 5 | 1 | Python | 2022-01-23 | none | Coinbase (via Twitter) → Binance buy | **AUTO-TRADE** | *"Script that listens to the @CoinbaseAssets twitter … and automatically buys 100 USDT worth of the new listing on Binance as soon as it is posted on Twitter."* | **Degraded.** Binance exists, but the X/Twitter API it depends on is now **paid** — the signal source no longer works free. |

---

## Table 2 — DEAD / ABANDONED / INCOMPLETE

Listing-related, but stale, broken, tiny, alert-only, or never wired to trade.

| full_name | ★ | forks | lang | last push | license | target | mode | staleness / status |
|---|---|---|---|---|---|---|---|---|
| defidummy/listing-trading-bot (prior-run) | 17 | 15 | – | 2021-05-26 | none | Binance news → Gate.io buy | AUTO-TRADE | ~5.4 yr stale (API shows pushed *before* created — treat dates loosely). |
| manuelhb14/exchangesListingsBot (prior-run) | 23 | 3 | Python | 2021-06-28 | none | Twitter → Telegram | **ALERT-ONLY** | ~5.3 yr stale; README says on-chain buy version lives elsewhere, Binance bot "future". |
| titouannwtt/bot-sniping-kucoin (prior-run) | 13 | 4 | Python | 2022-09-03 | none | KuCoin | AUTO-TRADE | ~4 yr stale; README tagged **[DEPRECATED]**; targets KuCoin v1 API (retired). |
| WonniPooh/Bittrex-Binance-Listing-Bot (prior-run) | 4 | 1 | Python | 2020-07-24 | none | Binance announce → Bittrex buy | AUTO-TRADE | ~6.2 yr stale; Bittrex US wound down. |
| yamato79/kucoin-sniper (prior-run) | 9 | 3 | JS | 2021-10-06 | none | KuCoin | snipe | ~5 yr stale. |
| 2manycoco/mexc_parse_listings (live) | 7 | 0 | Python | 2025-03-21 | Apache-2.0 | MEXC | **PARSE-ONLY** | Parses MEXC listing data; no trading. ~1.5 yr stale. |
| n-urs/telegram-keyword-GATE.IO-…-example (prior-run) | 2 | 0 | Python | 2025-06-09 | none | Telegram → Gate.io buy | AUTO-TRADE | README is an "example" template (clone URL says `yourusername`). |
| Tymonoo/Bybit-snipe-bot (live) | 0 | 0 | Python | 2026-03-26 | none | Telegram (BWEnews) → Bybit/Bitget futures | AUTO-TRADE | Recent but 0★/0 forks, ~12 KB; no traction/validation. |
| Sarahtonein/mexc-scan (live) | 1 | 0 | Python | 2026-09-07 | none | MEXC / Discord webhook | **ALERT-ONLY** | Very recent; README is a 5-line generic webhook bot, no MEXC detail. |
| RichieLoco/CoinSniper (live) | 2 | 1 | Java | 2025-09-11 | Apache-2.0 | Binance announce (+"AI") | **INCOMPLETE** | README TODO: *"Wiring into the APIs of the exchanges of which trading decisions have been made."* → assesses/logs only, **does not execute**. |
| fxm84/THE-HUNTER-Hyperliquid-Sniper-Bot (live) | 0 | 0 | TypeScript | 2026-01-24 | none | Hyperliquid | none | README is the stock **Google AI Studio** placeholder ("Run and deploy your AI Studio app") — no sniper code described. |
| brokxx/sell-sniper (live) | 0 | 0 | Python | 2026-09-16 | none | Hyperliquid | **AUTO-TRADE** (exit) | Genuinely works but it's an **exit/airdrop-dump sniper**, not a listing sniper: *"…sells a token as soon as it arrives (typically an airdrop)… filled ~1.4s after funds arrival."* Interesting adjacent tool. |
| JoeSvendsen/Bybit-listing-bot (403 this run; prior-run) | 0 | 0 | Python | 2025-08-07 | none | Bybit | **ALERT-ONLY** | *"🚀 Bybit Listing Notifier Bot"* — notifier only. |

**Different category (Solana/on-chain snipers — NOT CEX listing snipers), for contrast:** chainstacklabs/pumpfun-bonkfun-bot (1022★, **active**, pushed 2026-09-28, Apache-2.0 — the only well-maintained sniper found), FLOCK4H/Dexter (64★, active), zookyy/crypto-sniper (291★, DEX; homepage = commercial `eryx.io`), Scott-778/coinmarketcap-sniper-bot (131★, buys on BSC/PancakeSwap via CMC/CG Telegram alerts — on-chain, 0.7% fee), mouseless0x/Listing-Sniping-Bot (37★, DEX), yourarj/token-listing-sniper-bot (60★, Uniswap/PancakeSwap), 1fge/pump-fun-sniper-bot (300★, **archived**).

---

## Table 3 — FARM / SCAM / SOLICITATION

| full_name | ★ | forks | lang | last push | license | signal |
|---|---|---|---|---|---|---|
| **mortdeus/solana-copy-sniper-mev-trading-bot** | **4473** | 435 | Rust | 2026-09-21 | BSD-3-Clause | README is a marketing landing page that **begs for stars** and steers to **Telegram + a referral homepage** (`https://t.mercor.com/…`). Quotes: *"Star ⭐ and watch 👀 this repo so you don't miss it."* / *"If you find this project helpful, please star 🌟 the repo! Your feedback and stars motivate further development."* / *"Message me on Telegram: [@mortdeus]."* Title is keyword-stuffed (*"High speed solana mev arbitrage Sniper Copy Trading Bot, gRPC shred stream Pumpfun Bundler…"*). It is **not** a CEX sniper. Note: fork ratio (~9.7%) is higher than a pure farm, so treat as *organic stars + heavy solicitation*, not a 100% fake. |
| **Bigbidbot/CEX_Sniper** | 11 | 3 | – | 2024-02-27 | MIT | A **closed-source paid Windows `.exe`** sold under a license-key system ($150 to a hardcoded BEP20 address; Telegram support). README claims *"the first bot (Sniper) that buys tokens when listed on centralized exchanges (as Binance, MEXC (temporary don't work), OKEX, HUOBI and Gate.io)"* and states *"the bot is forbidden to resell and transfer … running more than three times at the same time will block your bot (money is not returned)."* It drives a logged-in browser via chromedriver (not the exchange API). **Not auditable — do not trust.** |

**Also flagged (SEO-spam landing-page READMEs found in the search set, no metrics fetched):** `MemeSnipe/Free-Solana-Sniper-Memecoins-Bot-2026` and `solana-snipe-bot/Free-SolanaSniperBot-2026-MemecoinAutoTrader` — both are one-screen ads pointing to `meme-snipe.com`, the same "Free … 2026" pattern as `topsecretagent007/Trading-Bot-Tools` (52★/16 forks, keyword-stuffed: *Pumpfun, Bonkfun, Bagsfm, Raydium…*). These are DEX, not CEX, and are the classic star-farm/SEO template.

---

## What the CEX listing-sniping gap means (build-it-yourself assessment)

The **API surface is not the problem** — it's the easiest part. Binance/Bybit/Gate/MEXC/OKX/Coinbase all expose REST + WebSocket, and `ccxt` unifies them (`load_markets`, `fetch_ticker`, `create_order`). The reason the public repos are dead is **economics + latency**, not API availability: announcement→first-candle latency is a crowded race on the majors, so the open-source forks stopped being maintained the moment the edge compressed.

**Moving parts for one competent dev (Python, some trading ops):**

1. **Signal (hardest, latency-critical).** Three tiers:
   - *Announcement scraping* (fastest public signal): Binance CMS announcement endpoint (`/bapi/composite/v1/public/cms/article/list/query`), plus Bybit/MEXC/Gate announcement APIs — poll every ~0.3–1 s, regex for "will list &lt;TOKEN&gt;".
   - *`exchangeInfo` diff*: `ccxt.fetch_markets()` every ~1–5 s, diff the symbol set. This fires **after** the announcement (when trading opens) — seconds slower, but it's the universal, venue-agnostic trigger.
   - *Social/Telegram* (BWEnews, `@CoinbaseAssets`): fastest for Coinbase-class listings, but the X API is now paid.
2. **Execution.** `create_order(type='market')`; size via `market['limits']['amount']['min']` and min-notional; handle `MARKET_NOT_OPEN`/`-1013`, insufficient-funds, and reject-due-to-precision using `amount_to_precision`. API key with **trade-only** perms + IP allowlist. Binance geo-blocks some IPs → run on a permissive-region VPS.
3. **Latency engineering.** Colocate the VPS in the venue's cloud region (Binance/Bybit/Gate ≈ Tokyo `ap-northeast-1`; Upbit/Bithumb ≈ Seoul; Coinbase ≈ `us-east-1`); `asyncio`/`aiohttp`/`uvloop`; on the hot path bypass ccxt's per-call overhead and hit raw REST with a warm keep-alive connection; pre-read timing/media.
4. **Risk & exit.** Buy on detection, then sell into the pump (fixed N-second window or laddered partials), hard stop, and guards against stablecoins/leveraged tokens, "announced but never opens", and thin books. Paper-trade against historical announcement→open prices first.
5. **Ops.** Secrets management, alerting, paper→live gate, per-venue rate-limit budget.

**Where `freqtrade` fits:** freqtrade is ccxt-based but **candle/timer-driven** (loops every few seconds), built for indicator strategies and post-trade position management — **not** sub-second event sniping. Best architecture is a thin bespoke "listener + trigger" service that fires a signal (webhook/REST), with freqtrade (or a small executor) handling sizing, TP/SL, trailing and reporting. Trying to make freqtrade itself poll `exchangeInfo` on its loop will be too slow to win. For a pure listing sniper, the whole job is small enough that **ccxt + asyncio alone is enough**; freqtrade only earns its keep if you want its risk/portfolio/telemetry layer.

**Difficulty:** a working, reliable **MVP is ~1–2 weeks** for one competent dev. A genuinely *competitive* one (colocated, sub-second, robust across venues) is a few weeks of tuning. The code is easy; **the durable edge is hard** — which is exactly why nothing in this space is maintained. Realistic remaining opportunity: smaller/regional venues and new **perpetual** listings, not Binance spot majors.

---

### Files produced this run
- `/Users/Admin/myterminal/verify2/CEX_LISTING_SNIPER_REPORT.md` (this report)
- `/Users/Admin/myterminal/verify2/verify.log` — HTTP codes per repo (12×200, rest 403 rate-limit)
- `/Users/Admin/myterminal/verify2/*.json` — raw `GET /repos` responses (the 12 verified)