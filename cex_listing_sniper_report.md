# CEX New-Listing Sniper Bots — GitHub Research Report
Generated 2026-10-03. All numbers from GitHub Search/Repo API responses. Search method: unauthenticated `api.github.com/search/repositories` (20 queries) + README via `raw.githubusercontent.com`.

Focus: bots that watch an exchange for a NEW listing/pair and place orders within seconds. Ranking = real usefulness for a solo, low-budget user (real + runnable + actually executes orders + maintained).

---

## 1. CyberPunkMetalHead/new-listings-trading-bot
- Stars 99 · Forks 28 · C# (.NET) · Last push 2025-01-30 · Archived no · License none
- https://github.com/CyberPunkMetalHead/new-listings-trading-bot
- Watches the Binance announcement page and auto-buys the announced coin on another exchange to ride the listing pump. Full strategy: take-profit + stop-loss, test mode, Dockerised.
- Exchange(s): monitors **Binance**, executes buy on **Poloniex**.
- API keys: yes (exchange trade keys). Executes real orders: yes.
- Evidence: *"This is a cryptocurrency trading bot designed to detect new coin listing announcements on Binance and immediately purchase the announced coin on a different exchange (currently configured to Poloniex)."*
- Practical: newest fully-built CEX listing sniper; basic .NET build, runs on a VPS. README pushes the author's paid "Aesir" service — the bot itself is free and complete. Poloniex liquidity is thin, so usable but not cutting-edge.

## 2. duckdegen/apebot
- Stars 1506 · Forks 471 · TypeScript · Last push 2023-06-15 · Archived no · License MIT
- https://github.com/duckdegen/apebot
- The famous "Binance Alpha" sniper: on a Binance listing it buys the token **on-chain** (via 0x/MetaMask) faster than the CEX order book opens, then routes/ sells into the Binance pump. Trades measured in tens of millions.
- Exchange(s): **Binance** (signal + sell) + on-chain DEX (buy).
- API keys: yes (on-chain RPC + CEX keys). Executes real orders: yes.
- Evidence: *"When a new token is listed in Binance, somewhere between 30-40 MM USD in volume pour in... Bots then compete to buy up the token onchain as quickly as possible."*
- Practical: the reference implementation, MIT, well documented. BUT abandoned (2023) and its README requires **paid infra** (CCXT Pro, Twilio, ProxyMesh, AWS). Free to clone; not turnkey free; the author quit because the edge closed.

## 3. rickstaa/crypto-listings-sniper
- Stars 13 · Forks 6 · Go · Last push 2024-12-12 · Archived no · License none
- https://github.com/rickstaa/crypto-listings-sniper
- Small, clean Go service that polls exchange APIs and fires a **Telegram/Discord alert <0.3 s** after a new listing appears. Multi-exchange by design (currently Binance).
- Exchange(s): **Binance** (others configurable).
- API keys: no (public endpoints) — alerting only. Executes real orders: **no**.
- Evidence: *"Posts a Discord/Telegram message when a new exchange listing is found."*
- Practical: the best free *monitor* to build your own sniper on top of; actively maintained, tiny, runs anywhere. Author notes he can no longer fund more exchanges. Not an order-placer by itself.

## 4. defidummy/listing-trading-bot
- Stars 17 · Forks 15 · Python · Last push 2021-05-26 · Archived no · License none
- https://github.com/defidummy/listing-trading-bot
- Reads Binance listing news and **auto-buys the coin on Gate.io before the pump** (listing arbitrage across two CEXs).
- Exchange(s): signal **Binance**, executes on **Gate.io**.
- API keys: yes. Executes real orders: yes.
- Evidence: *"Gets the coin listing news from Binance and buys the coin on Gate.io before the pump."*
- Practical: exactly the CEX→CEX arbitrage idea, simple Python. Old (2021) and unmaintained — expect to refresh API/news scraping, but a good small base.

## 5. n-urs/telegram-keyword-GATE.IO-automated-binance-listing-spot-buy-example
- Stars 2 · Forks 0 · Python · Last push 2025-06-09 · Archived no · License none
- https://github.com/n-urs/telegram-keyword-GATE.IO-automated-binance-listing-spot-buy-example
- Listens to Telegram channels for Binance listing text and places an automatic **market buy on Gate.io** the moment a matching keyword ("futures will launch", etc.) appears.
- Exchange(s): signal via Telegram/**Binance**, executes on **Gate.io**.
- API keys: yes (Gate.io key + Telegram creds + a CMC/news key). Executes real orders: yes.
- Evidence: *"Listens for three types of listing messages on Telegram: 1. Futures launch announcements containing 'futures will launch'..."*
- Practical: recent, readable, exactly the "Telegram listing alert → auto spot buy" pattern; runnable on a cheap VPS. Tiny community, no tests.

## 6. georgGrankvist/CoinbaseListingSniper
- Stars 5 · Forks 1 · Python · Last push 2022-01-23 · Archived no · License none
- https://github.com/georgGrankvist/CoinbaseListingSniper
- Watches the **@CoinbaseAssets** Twitter feed and buys **100 USDT** of any newly-announced Coinbase listing on Binance within seconds of the tweet.
- Exchange(s): signal Coinbase/Twitter, executes on **Binance**.
- API keys: yes (Binance key + Twitter API). Executes real orders: yes.
- Evidence: *"Script that listens to the @CoinbaseAssets twitter to find information about new Coinbase listings, and automatically buys 100 USDT worth of the new listing on Binance as soon as it is posted on Twitter."*
- Practical: ~30-line single script, trivial to audit and adapt. Needs a (now paid) Twitter API token. 2022, unmaintained.

## 7. Tymonoo/Bybit-snipe-bot
- Stars 0 · Forks 0 · Python · Last push 2026-03-26 · Archived no · License none
- https://github.com/Tymonoo/Bybit-snipe-bot
- Telegram-channel monitor that detects new token listings/delistings and **auto-opens LONG positions on Bybit USDT-M futures** with risk management.
- Exchange(s): **Bybit** (futures).
- API keys: yes. Executes real orders: yes.
- Evidence: *"The bot monitors selected Telegram channels for new token listings or delisting and automatically opens LONG positions with built-in risk management."*
- Practical: recent and on-target (futures listing snipe). Zero stars/unproven, and README inconsistently mentions "Bitget API" — verify the exchange wiring before funding a key.

## 8. CyberPunkMetalHead/binance-trading-bot-new-coins
- Stars 1503 · Forks 269 · Python · Last push 2021-10-21 · Archived no · License MIT
- https://github.com/CyberPunkMetalHead/binance-trading-bot-new-coins
- The classic 1.5k-star bot: detects new coins the moment they list on Binance and automatically fires buy/sell orders to ride the spike.
- Exchange(s): **Binance**.
- API keys: yes. Executes real orders: yes.
- Evidence: *"This Binance trading bot detects new coins as soon as they are listed on the Binance exchange and automatically places sell and buy orders."*
- Practical: hugely popular and MIT, but from 2021 — Binance API/newsflow changed a lot, so treat as a code reference rather than turnkey. Community forks exist.

## 9. chainstacklabs/pumpfun-bonkfun-bot
- Stars 1022 · Forks 354 · Python · Last push 2026-09-28 · Archived no · License Apache-2.0
- https://github.com/chainstacklabs/pumpfun-bonkfun-bot
- Actively-maintained **DEX** sniper for pump.fun / letsbonk.fun launches: watches the chain for new tokens and buys immediately, with configurable sell logic and multiple listeners (logs/blocks/geyser/shreds).
- Exchange(s): **Solana DEX** (pump.fun, Bonk) — not a CEX, but same "snipe the open" mechanic.
- API keys: no; requires `SOLANA_PRIVATE_KEY` (wallet key) + Solana RPC. Executes real orders: yes (on-chain).
- Evidence: env table lists *"SOLANA_PRIVATE_KEY | Base58 private key of the trading wallet"*.
- Practical: the most polished, best-supported pump.fun sniper (Chainstack-maintained, huge community). Free, runs on a VPS. Requires a funded Solana wallet — key-security risk.

## 10. brokxx/sell-sniper
- Stars 0 · Forks 0 · Python · Last push 2026-09-16 · Archived no · License none
- https://github.com/brokxx/sell-sniper
- Watches a **Hyperliquid** spot account and sells a target token the instant it arrives (listing / airdrop "sell sniper") via a wallet agent. One-line installer.
- Exchange(s): **Hyperliquid** (spot).
- API keys: wallet/agent key (Hyperliquid). Executes real orders: yes.
- Evidence: *"Bot qui surveille un compte spot Hyperliquid et vend un token (KNTQ, TREAD…)"* (watches a Hyperliquid spot account and sells a token).
- Practical: only real Hyperliquid new-market tool found, but ~2 weeks old, 0 stars, no tests — review the script before running. French docs.

## 11. FLOCK4H/Dexter
- Stars 64 · Forks 18 · Python · Last push 2026-03-28 · Archived no · License none
- https://github.com/FLOCK4H/Dexter
- Full-featured **pump.fun (Solana DEX)** sniping application: token discovery + live buys, datastore, wsLogs supervision and explicit mainnet "dry-run vs live" safety gates.
- Exchange(s): **Solana DEX** (pump.fun).
- API keys: wallet key. Executes real orders: yes (on-chain, gated).
- Evidence: *"safety gates: leave `DEXTER_MAINNET_DRY_RUN=true` and `DEXTER_ALLOW_MAINNET_LIVE=false` until you intentionally want live mainnet sends."*
- Practical: actively developed with sensible safety defaults; free. DEX/pump.fun, so not a CEX listing tool.

## 12. Bigbidbot/CEX_Sniper
- Stars 11 · Forks 3 · (binaries) · Last push 2024-02-27 · Archived no · License MIT
- https://github.com/Bigbidbot/CEX_Sniper
- Buys tokens the moment they list on centralized exchanges. The GitHub repo is **documentation + release binaries only** — the actual sniper is a paid, licensed Windows .exe.
- Exchange(s): **Binance, MEXC, OKEX, HUOBI, Gate.io**.
- API keys: yes (keys entered in config). Executes real orders: yes (via bundled browser automation).
- Evidence: *"This is the first bot (Sniper) that buys tokens when listed on centralized exchanges (as Binance, MEXC (temporary don't work), OKEX, HUOBI and Gate.io)."*
- Practical: **NOT real open source** — a wrapper around a ~$150 licensed product; free download only test-trades MATIC. Listed for completeness because it directly targets the category; skip unless you want to pay.

---

## Also seen (real but lower value / alert-only)
- **JoeSvendsen/Bybit-listing-bot** — 0★, Py, pushed 2025-08-07: polls Bybit spot every 5-10 s, Telegram alert only (no orders).
- **manuelhb14/exchangesListingsBot** — 23★, Py, 2021: Twitter→Telegram listing alerts (Binance only now).
- **2manycoco/mexc_parse_listings** — 7★, Py, 2025: minimal MEXC new-listing parser.
- **everydaycodings/Binance-Listing-Bot** — 8★, Py, 2022: tiny Binance testnet demo.
- **1fge/pump-fun-sniper-bot** — 300★, Go, **archived** 2024-08: a genuinely good pump.fun sniper, now archived; use as reference.
- **Scott-778/coinmarketcap-sniper-bot** — 131★, JS, 2022: BSC **DEX** buy on CMC/CG listing alerts; charges 0.7% fee, needs BSC seed phrase (risky).
- **yourarj/token-listing-sniper-bot** — 60★ Rust, **mouseless0x/Listing-Sniping-Bot** — 37★ JS, **zookyy/crypto-sniper** — 291★ JS: all **DEX** liquidity/Uniswap-style snipers (zookyy funnels to a paid "premium"). No CEX.
- **titouannwtt/bot-sniping-kucoin** — 13★ Ky, 2022, README self-declared DEPRECATED.

## AVOID (scammy / empty / keyword-farm)
1. **mortdeus/solana-copy-sniper-mev-trading-bot** — 4473★ but created **2013-03-01** (an old repo renamed), BSD tag, keyword-stuffed description, README funnels to a Telegram for "custom" paid work. Classic star-farmed wallet-risk repo.
2. **MemeSnipe/Free-Solana-Sniper-Memecoins-Bot-2026** — 123★ but only **1 fork**, README is a marketing page for meme-snipe.com, "we generate a wallet for you — just send SOL". No source code. High risk (wallet drainer pattern).
3. **solana-snipe-bot/Free-SolanaSniperBot-2026-MemecoinAutoTrader** — 85★ / 6 forks, same meme-snipe.com funnel, SEO keyword stuffing, no real code.
4. **fxm84/THE-HUNTER-Hyperliquid-Sniper-Bot** — name promises a Hyperliquid sniper but the README is just a generic Google **AI Studio (Gemini) to-do template** ("Set the GEMINI_API_KEY..."). Name/label mismatch = fake.
5. **topsecretagent007/Trading-Bot-Tools** — 52★ index page linking to a pile of "Volume/Sniper Bot" subfolders; keyword-stuffed, promotes paid bots. Not a working tool.
6. (bonus) **web3batman/Solana_Memecoin_Sniper_Bot** — 288★, thinly reskinned Solana sniper with contact emails/Telegram for paid builds; treat as a sales funnel.
