# Open-Source Airdrop / Primary-Market Monitoring & On-Chain Trading Bots — Ranked Report

Data source: GitHub REST API (`/search/repositories`, `/repos/{full_name}`) + raw READMEs, harvested **2026-10-03 (UTC)**. Every star/fork/date/license figure below comes from an actual API response in this run. Rankings within each bucket are by usefulness to a solo dev, not by stars.

> **WALLET-KEY WARNING (read first).** Many projects here demand a wallet **private key / seed phrase** in a `.env` file. Putting a funded key into third-party code is the #1 way solo users get drained. Any repo that asks for a private key is marked **🔑 HIGH RISK**. Prefer read-only trackers, or use a freshly generated, lightly funded throwaway wallet, and audit the code before funding anything.

Legend: **(a)** legitimate & actively maintained · **(b)** teaching / reference / library · **(c)** abandoned but historically important · **(d)** scam / spam / funnel.

---

## Bucket 1 — Airdrop monitoring / farming / auto-claim

### 1. masterking32/MasterCryptoFarmBot — **(b) framework, semi-stale**
- Stars **243** · Forks **36** · Python · Last push **2025-06-09** · Archived: **no** · License **CC0-1.0**
- URL: https://github.com/masterking32/MasterCryptoFarmBot
- What it does: README calls it a "foundational system for building crypto farming and airdrop bots for Telegram-based games" — a modular framework (proxy manager, account manager, plugin bots) rather than one specific airdrop.
- Targets: Telegram mini-app games + multi-chain account orchestration.
- 🔑 Needs private keys / Telegram session tokens for the plugins it farms. **HIGH RISK.**
- Verdict: Best *foundation* if you want to build your own multi-account farmer, but ~16 months since last push, so treat as a starting template, not a maintained product.

### 2. chord1990/Lighter-Airdrop-Tracker — **(a) legitimate, safe**
- Stars **35** · Forks **9** · Python · Last push **2026-08-02** · Archived: **no** · License **MIT**
- URL: https://github.com/chord1990/Lighter-Airdrop-Tracker
- What it does: README states it tracks Lighter points, trading volume and leaderboard rank in the terminal, ticks season farming tasks, and estimates airdrop allocation. Explicitly "Read-only: public Lighter API, **no private keys**."
- Targets: Lighter (zk L2 DEX / points program).
- 🔑 **No wallet key required** — read-only by design. This is the only "airdrop" pick here that is safe by construction.
- Verdict: Immediately usable by one user today. Ideal monitoring layer to run alongside real activity.

### 3. dante4rt/blum-airdrop-bot — **(a) works, ToS risk**
- Stars **138** · Forks **80** · JavaScript · Last push **2026-03-21** · Archived: **no** · License **MIT**
- URL: https://github.com/dante4rt/blum-airdrop-bot
- What it does: Automates the Blum airdrop platform — claiming rewards, managing farming sessions, completing daily tasks, and playing the drop game. Uses account/query tokens, proxies.
- Targets: Blum (Telegram mini-app, BNB-chain adjacent).
- 🔑 Uses Telegram auth tokens, not a chain private key. Still against Blum ToS → account-ban risk.
- Verdict: Run-able solo for a small number of accounts; expect ToS/enforcement risk, not code bugs.

### 4. dante4rt/nodepay-airdrop-bot — **(a) works, ToS risk**
- Stars **111** · Forks **48** · JavaScript · Last push **2025-01-23** · Archived: **no** · License **MIT**
- URL: https://github.com/dante4rt/nodepay-airdrop-bot
- What it does: Automates Nodepay airdrop interactions — session management and keep-alive pings with proxy support.
- Targets: Nodepay (DePIN bandwidth network, Solana-side points).
- 🔑 Token/account based; no chain private key required.
- Verdict: Simple and usable, but ~21 months stale — its token/API flow may already be broken.

### 5. SZharkov/arbitrum-airdrop-claimer — **(c) historical, one-shot**
- Stars **50** · Forks **32** · JavaScript · Last push **2023-03-23** · Archived: **no** · License **none declared**
- URL: https://github.com/SZharkov/arbitrum-airdrop-claimer
- What it does: Claims an ARB token airdrop and forwards to specified accounts, including DEX pre-approvals — a purpose-built script for the March-2023 Arbitrum claim.
- Targets: Arbitrum (Ethereum L2).
- 🔑 Requires private keys to sign claim txs. **HIGH RISK.**
- Verdict: Historically the reference "auto-claim" script; the ARB claim is long over, so keep it as a **template for claim-automation**, not something to run now.

### 6. MeoMunDep/Automatic-Ultimate-Create-Wallets-for-Airdrop — **(d-ish) usable but supply-chain risk**
- Stars **79** · Forks **8** · Shell · Last push **2025-12-19** · Archived: **no** · License **none declared**
- URL: https://github.com/MeoMunDep/Automatic-Ultimate-Create-Wallets-for-Airdrop
- What it does: Bulk-generates wallets across EVM, TON, TRON, SUI, Aptos, Cardano, Algorand, Hedera, NEAR, Solana, Polkadot, Cosmos, Bitcoin, etc. — a multi-chain wallet factory for farming ops.
- Targets: ~16 chains.
- 🔑 Generates and writes private keys/mnemonics to disk. **HIGH RISK** — and its README pushes Node installs and scripts via Telegram channels, a classic supply-chain vector. Do not download binaries/scripts from those links.
- Verdict: Concept is useful (bulk keygen) but only trust the reviewed source; the distribution model is the danger.

---

## Bucket 2 — Launchpad & DEX sniper / bundle / MEV

### 1. chainstacklabs/pumpfun-bonkfun-bot — **(a) best all-round Solana sniper**
- Stars **1022** · Forks **354** · Python · Last push **2026-09-28** · Archived: **no** · License **Apache-2.0**
- URL: https://github.com/chainstacklabs/pumpfun-bonkfun-bot
- What it does: README: "A fully functional pump.fun / letsbonk.fun trading and sniping bot **not relying on any 3rd party APIs**" — buys/sells on bonding-curve launches, configurable slippage/TP/SL, own RPC.
- Targets: Solana (pump.fun, letsbonk.fun).
- 🔑 Requires `SOLANA_PRIVATE_KEY` + RPC endpoint in `.env`. **HIGH RISK.**
- Verdict: Backed by Chainstack (real infra company), reasonably documented, self-contained. The most realistic Solana sniper for one dev to fork and run today — but fund a throwaway wallet.

### 2. 0xfnzero/sol-trade-sdk — **(b) library to build on**
- Stars **346** · Forks **157** · Rust · Last push **2026-10-02** · Archived: **no** · License **MIT**
- URL: https://github.com/0xfnzero/sol-trade-sdk
- What it does: "A high-performance Rust SDK for low-latency Solana DEX trading bots," with adapters for PumpFun, PumpSwap, Bonk, Raydium AMM v4 / CPMM, Meteora DAMM v2, plus Jito and SWQoS submit lanes. Published on crates.io/docs.rs.
- Targets: Solana (all major launchpads/DEXes).
- 🔑 SDK only — you supply keypair/signing; it is not a turnkey bot. **Key handling is your responsibility (HIGH RISK if you copy examples blindly).**
- Verdict: The cleanest, licensed building block if you want to write your own sniper rather than trust a random repo's full stack.

### 3. jito-labs/mev-bot — **(a)/(b) official Jito reference**
- Stars **1195** · Forks **375** · TypeScript · Last push **2025-04-25** · Archived: **no** · License **Apache-2.0**
- URL: https://github.com/jito-labs/mev-bot
- What it does: Jito Labs' own TypeScript MEV bot demonstrating how to build and submit **Jito bundles** on Solana (backrun/liquidation-style strategies). Authoritative reference for the Jito bundle flow.
- Targets: Solana (Jito block engine).
- 🔑 Expects a keypair to sign bundles. **HIGH RISK.**
- Verdict: Official and instructive, but ~5 months since last push and written as a demo/example — learn the bundle mechanics from it, don't expect a maintained product.

### 4. degatchi/mev-template-rs — **(b) teaching boilerplate**
- Stars **727** · Forks **125** · Rust · Last push **2026-04-14** · Archived: **no** · License **MIT**
- URL: https://github.com/degatchi/mev-template-rs
- What it does: "Bootstrap your MEV bot strategies with a simple boilerplate to build on top of" — minimal Rust skeleton for a generic (EVM-style) MEV bot.
- Targets: Generic EVM MEV (not Solana-specific).
- 🔑 Key management left to you. **HIGH RISK if funded.**
- Verdict: A teaching/starting template, not a ready strategy. Good for learning MEV architecture.

### 5. Rabnail-SOL/Solana-PumpFun-Bundler — **(a) functional bundler, high-key risk**
- Stars **189** · Forks **54** · TypeScript · Last push **2025-03-19** · Archived: **no** · License **MIT**
- URL: https://github.com/Rabnail-SOL/Solana-PumpFun-Bundler
- What it does: Creates a pump.fun pool and bundle-buys with **20 wallets** in a single Jito bundle — an anti-sniper / launch-bundling tool for fair-launch participation.
- Targets: Solana (pump.fun + Jito).
- 🔑 Requires **20 private keys**. 🔑🔑 **VERY HIGH RISK** — one leak drains the bundle.
- Verdict: Genuinely does what it says, but operating 20 funded keys from one machine is a huge blast radius. Not for casual use; ~1.5 years stale.

### 6. mortdeus/solana-copy-sniper-mev-trading-bot — **(d/hype) popular but keyword-stuffed**
- Stars **4473** · Forks **435** · Rust · Last push **2026-09-21** · Archived: **no** · License **BSD-3-Clause**
- URL: https://github.com/mortdeus/solana-copy-sniper-mev-trading-bot
- What it does: README advertises a "free high-speed solana mev arbitrage sniper copy-trading bot, gRPC shred stream, Pumpfun bundler, token launcher, raydium pool creator, sandwich bot …". Repository contains real Rust + JS (~450 KB) but the description is keyword-stuffed (repeats "solana trading bot" 4×) and the README is largely marketing + "hire me" Telegram solicitations.
- Targets: Solana (pump.fun, Raydium, copies/trades).
- 🔑 Expects private keys. **HIGH RISK.**
- Verdict: The most-starred Solana "sniper" repo, but the hype/solicitation pattern means you must audit every line before trusting it; never let it generate or hold a funded key. Listed here for completeness, not as a recommendation.

---

## Bucket 3 — CEX/DEX automated-trading frameworks (baseline, to build your own)

These are the mature, real projects. They trade your *account* on centralized exchanges (API key + secret, usually **no withdraw permission needed** — still 🔑 sensitive but far lower risk than raw on-chain private keys).

### 1. freqtrade/freqtrade — **(a) the reference baseline**
- Stars **54998** · Forks **11382** · Python · Last push **2026-10-03** · Archived: **no** · License **GPL-3.0**
- URL: https://github.com/freqtrade/freqtrade
- What it does: "Free, open source crypto trading bot" — strategy engine with backtesting, hyperopt, dry-run, paper trading, FreqAI ML, Telegram control; connects to 20+ exchanges via ccxt.
- Targets: Binance, Bybit, Kraken, OKX, Kucoin and many CEX/DEX via ccxt.
- 🔑 Exchange API key/secret (read + trade; **do not enable withdrawals**).
- Verdict: The safest, best-documented place to start any automated-trading project. Run it in `dry-run` first — genuinely usable solo today.

### 2. ccxt/ccxt — **(b) library, the plumbing**
- Stars **44238** · Forks **8873** · Python · Last push **2026-10-03** · Archived: **no** · License **MIT**
- URL: https://github.com/ccxt/ccxt
- What it does: "A unified trading API with more than 100 crypto exchanges and prediction markets" — JS/TS/Python/C#/PHP/Go/Java/Rust. It is a *library*, not a bot.
- Targets: 100+ CEX + prediction markets.
- 🔑 You pass exchange API keys yourself. **Key handling is your code's job.**
- Verdict: Not a bot, but the backbone almost every other project here (freqtrade, OctoBot, Hummingbot tooling) depends on. Learn it.

### 3. hummingbot/hummingbot — **(a) market-making/HFT baseline**
- Stars **20294** · Forks **4974** · Python · Last push **2026-09-28** · Archived: **no** · License **Apache-2.0**
- URL: https://github.com/hummingbot/hummingbot
- What it does: "Open source software that helps you create and deploy high-frequency crypto trading bots" — market making, arbitrage, liquidity provision across CEX **and** DEX with a strategy framework.
- Targets: 20+ CEX plus on-chain DEX connectors (Ethereum/Solana etc.).
- 🔑 Exchange API keys; DEX connectors use wallet keys. **HIGH RISK for DEX side.**
- Verdict: Industrial-strength and actively maintained, but heavy to operate (Docker, gateway). Overkill for a solo tinkerer; excellent reference.

### 4. Drakkar-Software/OctoBot — **(a) friendly self-hosted bot**
- Stars **6674** · Forks **1278** · Python · Last push **2026-10-01** · Archived: **no** · License **GPL-3.0**
- URL: https://github.com/Drakkar-Software/OctoBot
- What it does: "Free open source crypto trading bot to automate AI, Grid, DCA and TradingView strategies on Binance, Hyperliquid and 15+ exchanges, with a simple interface."
- Targets: Binance, Hyperliquid + 15 other exchanges.
- 🔑 Exchange API keys (trade-only).
- Verdict: GUI + strategy marketplace make it the easiest full bot to self-host and actually run. Good solo pick if you want batteries-included.

### 5. enarjord/passivbot — **(a) grid/martingale workhorse**
- Stars **2117** · Forks **678** · Python · Last push **2026-10-03** · Archived: **no** · License **Unlicense**
- URL: https://github.com/enarjord/passivbot
- What it does: Grid/martingale "passive" trading bot with a long track record; README lists Bybit, Bitget, OKX, GateIO, Binance, Kucoin, WEEX, Hyperliquid.
- Targets: 8 exchanges incl. Hyperliquid.
- 🔑 Exchange API keys (trade-only).
- Verdict: Mature, permissively licensed (public domain), actively pushed. Great for someone who wants a proven grid engine to extend.

### 6. c9s/bbgo — **(a) Go framework (alternative to Python stacks)**
- Stars **1670** · Forks **385** · Go · Last push **2026-10-02** · Archived: **no** · License **AGPL-3.0**
- URL: https://github.com/c9s/bbgo
- What it does: "The modern cryptocurrency trading bot framework written in Go" — a strategy framework with exchange sessions, indicators and backtesting.
- Targets: Binance, OKX, Bybit and others.
- 🔑 Exchange API keys (trade-only).
- Verdict: Best pick if you prefer Go over Python; active and well-structured. (Go users: **rodrigo-brito/ninjabot**, 1626★, MIT, Binance — also solid.)

---

## Bucket 4 — On-chain points / testnet farming automation

### 1. dante4rt/t3rn-airdrop-bot — **(a) active, ToS/keys risk**
- Stars **206** · Forks **70** · JavaScript · Last push **2024-09-14** · Archived: **no** · License **MIT**
- URL: https://github.com/dante4rt/t3rn-airdrop-bot
- What it does: "Automates transactions and bridging assets on the t3rn network" — repeated testnet bridging to accumulate points.
- Targets: t3rn (cross-chain testnet).
- 🔑 Requires wallet private keys to sign testnet txs. **HIGH RISK** (testnet keys are usually throwaway, but reuse is common — never reuse a real key).
- Verdict: Typical points-farming loop, well-starred for its niche; testnet programs are usually over by the time you read this.

### 2. vikitoshi/Pharos-Auto-Bot — **(a) active, keys required**
- Stars **125** · Forks **41** · JavaScript · Last push **2025-05-26** · Archived: **no** · License **none declared**
- URL: https://github.com/vikitoshi/Pharos-Auto-Bot
- What it does: README: swaps WPHRS/USDC, sends PHRS, claims faucet, daily check-ins, proxy + multi-wallet support — explicitly to "qualify for airdrops."
- Targets: Pharos Testnet (EVM L1).
- 🔑 **Needs testnet wallet private keys** + optional proxies. **HIGH RISK.**
- Verdict: A clean, single-purpose testnet farmer; the canonical shape of this category. No license, so fork at your own legal discretion.

### 3. MeoMunDep/Automatic-Ultimate-Create-Wallets-for-Airdrop — **(d-ish) see Bucket 1 #6**
- Stars **79** · Forks **8** · Shell · Last push **2025-12-19** · Archived: **no** · License **none declared**
- URL: https://github.com/MeoMunDep/Automatic-Ultimate-Create-Wallets-for-Airdrop
- What it does: Mass multi-chain wallet generation (16+ chains) to feed farming fleets. 🔑 Handles mnemonics/keys on disk. **HIGH RISK** + Telegram-based distribution.
- Verdict: Useful keygen concept; only run reviewed source, never the Telegram-delivered installers.

### 4. dante4rt/plume-testnet-bot — **(a) niche, semi-stale**
- Stars **59** · Forks **26** · JavaScript · Last push **2024-09-07** · Archived: **no** · License **MIT**
- URL: https://github.com/dante4rt/plume-testnet-bot
- What it does: "Interacts with the Plume Testnet faucet and manages transactions automatically" — faucet + tx loop for points.
- Targets: Plume Testnet (RWA-focused L2).
- 🔑 Wallet private keys required. **HIGH RISK.**
- Verdict: Same template as the others; ~2 years stale, so its endpoints are likely dead.

### 5. Widiskel/walrus-testnet-bot — **(c) archived, historical**
- Stars **67** · Forks **15** · JavaScript · Last push **2025-02-01** · Archived: **YES** · License **MIT**
- URL: https://github.com/Widiskel/walrus-testnet-bot
- What it does: Automates SUI/WAL swaps, staking to a node operator, and faucet requests on the Walrus (SUI) testnet for airdrop eligibility.
- Targets: SUI (Walrus testnet).
- 🔑 Wallet keys required. **HIGH RISK.**
- Verdict: Archived — read it as a **reference implementation** of a testnet-farm loop, don't expect updates.

### 6. FarmerAgentbsc/farmer-agent-app — **(a?) full-stack app, unclear**
- Stars **63** · Forks **6** · HTML/JS · Last push **2026-04-21** · Archived: **no** · License **none declared**
- URL: https://github.com/FarmerAgentbsc/farmer-agent-app
- What it does: README: "Farmer Agent on BSC Chain: farm-themed AI agent dashboard, cloud console, airdrop festival, and deployment stack" — a full-stack (frontend + server + Postgres) points/farming product.
- Targets: BNB Smart Chain.
- 🔑 Has a backend; treat any wallet/keys it manages as compromised-by-default. **Treat as HIGH RISK / unvetted.**
- Verdict: More of a product repo than a script; ~16 MB, no license. Interesting only if you want the dashboard pattern — audit before running.

---

## AVOID — scams / empty / funnels (no real code or pure promo)

1. **MemeSnipe/Free-Solana-Sniper-Memecoins-Bot-2026** — Stars 123 · Forks 1 · no language · repo size **3 KB** · README is a landing page funnelling to `meme-snipe.com` "premium verified bot." **Empty marketing repo (d).**
2. **solana-snipe-bot/Free-SolanaSniperBot-2026-MemecoinAutoTrader** — Stars 85 · Forks 6 · **5 KB**, no real code, "premium Solana Sniper Bot" upsell. **Spam/funnel (d).**
3. **BundlerBullet/BundlerBullet** — Stars 79 · Forks 2 · **15 KB**, README is essentially a logo image + "A Raydium & pump.fun bundler" claim, no implementation. **Empty (d).**
4. **Crypt0Verse/grass-x3-bot** — Stars 79 · Forks 68 · no language · **5 KB**, README markets "x3 Grass points" farming with no code. **Empty marketing (d).**
5. **DeFiCryptoBots/CryptoBots-Solana-Sniper-PumpFun-Free** — Stars 73 · 707 KB JS but README is a "free trial → paid Apex Sniper (cryptobots.tech)" funnel. **Promotional funnel — treat any key it asks for as stolen (d).**

(Also flag: **mortdeus/solana-copy-sniper-mev-trading-bot** has real code but a keyword-stuffed, solicitation-heavy README — see Bucket 2 #6. Verify before trusting.)

---

## Synthesis — what a solo dev could realistically fork and run today

For **monitoring** without risk, fork **chord1990/Lighter-Airdrop-Tracker** — it is read-only, MIT, only weeks old, and needs no keys, so it is the one component you can safely deploy on day one to watch points/eligibility. For **on-chain sniping/launchpad participation**, **chainstacklabs/pumpfun-bonkfun-bot** (1022★, Apache-2.0, pushed 2026-09-28) is the most trustworthy turnkey bot — it is self-contained (no third-party API), comes from a real infra company, and is Python you can read end-to-end; run it against a fresh, minimally funded wallet and its own RPC. If you would rather **write your own Solana trader** instead of running someone else's full stack, build on **0xfnzero/sol-trade-sdk** (346★, MIT, pushed 2026-10-02) plus the official **jito-labs/mev-bot** for bundle submission, so you control every line that touches your key. For anything **farming** (Telegram games, testnets, auto-claim), treat all of Bucket 1/4 as **throwaway-key territory**: they exist and mostly work, but they want your private keys and violate platform ToS — use fresh wallets that you never reuse for real funds. Finally, for **off-chain trading frameworks** the safe, mature trio is **freqtrade** (54,998★, GPL-3.0, dry-run first), **OctoBot** (6,674★, GUI) and **passivbot** (2,117★, public-domain grid engine); all three need only trade-enabled exchange API keys and can be run today. Bottom line: one safe monitor (Lighter tracker), one fork-and-run sniper (chainstacklabs pump.fun bot), one build-your-own SDK (sol-trade-sdk) — everything else is either a reference to study or bait to avoid.
