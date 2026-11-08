# Solana Trading Bot

An automated **Solana sniping bot** that trades newly-listed tokens on **Raydium AMM v4** and **pump.fun** bonding curves. Listens to on-chain events in real time, applies configurable safety filters, buys with your chosen quote token (WSOL / USDC), and auto-sells on take-profit / stop-loss.

> ⚠️ **Disclaimer.** This software is provided **as-is** for educational purposes. Sniping memecoins is extremely risky — rug pulls, honeypots, sandwiching, and total loss are common outcomes. Use only funds you can afford to lose. You are solely responsible for every transaction this bot signs with your private key.
>
**For collaboration or development work:**

- **Telegram** — [@k02_xx](https://t.me/k02_xx)

---

## What's new in 3.0

- Jupiter best-price **sells** (and pump.fun graduation fallback)
- Cross-DEX **arbitrage** engine (Raydium group vs Orca/Meteora/PumpSwap)
- **Trailing stop**, optional scale-out take-profit, buy cooldown
- Dynamic priority fees + pre-send **simulation**
- Copy-trade from watched wallets
- Circuit breaker, top-holder filter, sell-in-progress lock
- Fixed OpenBook market vaults, Jito swap confirmation, and snipe-list comments

Existing `.env` files keep working — new keys have defaults. Copy extras from `.env.copy` to tune them.

## Features

- 🦅 **Raydium AMM v4 sniper** — listens for newly-opened liquidity pools and buys within the same block window.
- 🚀 **pump.fun integration** — detects new token creations on the pump.fun bonding-curve program and buys early; sells via bonding curve until graduation.
- ⚡ **Three transaction executors** — `default` (regular RPC), `warp` (warp.id bundled relay), `jito` (Jito bundle fan-out to five block-engine regions).
- 🧠 **Jupiter smart routing** — sells via Jupiter when the aggregator beats a direct Raydium quote; also used after pump.fun graduation.
- 🔄 **Cross-DEX arbitrage** — scans SOL/USDC and SOL/USDT across Raydium vs Orca/Meteora/PumpSwap and executes two-leg arb when profit clears fees.
- 📡 **Copy trade** — optionally mirrors buys from a list of tracked wallets via Jupiter.
- 📉 **Trailing stop + scale-out** — peak-based trailing exit, optional partial take-profit, post-sell cooldown.
- 🛡️ **Pool filters** — burn check, mint renounced, freeze authority, metadata mutability, socials, pool size range, top-holder concentration.
- 🎯 **Snipe list** — restrict buys to a whitelist of mint addresses refreshed from `snipe-list.txt`.
- 📈 **Auto-sell** — take-profit / stop-loss / trailing-stop polling against live pool state for both Raydium and pump.fun.
- 🔒 **Concurrency guard** — `ONE_TOKEN_AT_A_TIME` mode via mutex to avoid fighting yourself across new pools.
- 🧯 **Circuit breaker** — pause new trades after consecutive execution failures.
- 🧪 **Dry-run + simulation** — simulate trades (and optionally skip broadcast) before risking funds.
- 🚦 **Risk caps** — max open positions + daily buy limits for Raydium, pump.fun, and arbitrage.

---

## Architecture

```
┌────────────────┐    ┌────────────────┐    ┌────────────────┐
│   Listeners    │───▶│      Bot       │───▶│   Transaction  │
│ (WS subscrs.)  │    │  (buy / sell)  │    │    Executor    │
└────────────────┘    └────────────────┘    └────────────────┘
        │                     │                     │
        │                     │                     ├─ default RPC
        │                     │                     ├─ warp.id
        │                     │                     └─ Jito bundles
        │                     │
        │                     ├─ PoolFilters (burn / renounced / socials / size / holders)
        │                     ├─ Jupiter router (best-price sells + copy buys)
        │                     ├─ Trailing stop / scale-out / cooldown
        │                     ├─ CircuitBreaker + PositionBook
        │                     ├─ SnipeListCache
        │                     ├─ MarketCache / PoolCache
        │                     └─ PumpFunCache
        │
        ├─ OpenBook markets      (quoteMint memcmp)
        ├─ Raydium AmmV4 pools   (status=6, quoteMint memcmp)
        ├─ pump.fun logs         (Create instruction)
        ├─ Copy wallets          (SPL balance increases → Jupiter buy)
        └─ Wallet SPL changes    (token balance deltas → auto-sell)

┌────────────────────────────────────────────────────────────┐
│ ArbitrageEngine (optional)                                 │
│ Jupiter dex-restricted quotes: Raydium group vs Orca/Meteora│
│ Two-leg execute when profit > min bps + tip buffer         │
└────────────────────────────────────────────────────────────┘
```

Key modules:

| Path | Purpose |
|------|---------|
| `index.ts` | Entry point — wires `Connection`, `Listeners`, `Bot`, event handlers. |
| `bot.ts` | `Bot` class — Raydium `buy`/`sell` + pump.fun `buyPumpFun`/`sellPumpFun`, filter & price matching. |
| `listeners/` | WebSocket subscriptions (OpenBook, Raydium, pump.fun logs, wallet). |
| `cache/` | In-memory stores for markets, Raydium pools, pump.fun bonding curves, snipe list. |
| `filters/` | Pluggable safety filters applied before a buy. |
| `risk/` | Circuit breaker and in-memory position book. |
| `arbitrage/` | Cross-DEX two-leg scanner using Jupiter dex filters. |
| `transactions/` | Pluggable executors (`default`, `warp`, `jito`). |
| `helpers/` | Env loader, logger, wallet parser, Raydium/pump.fun/Jupiter helpers & pricing. |

---

## Requirements

- **Node.js ≥ 18**
- A funded **Solana wallet** (keep a **dedicated** keypair for the bot — never use your main one).
- A **reliable RPC** — public `api.mainnet-beta.solana.com` will throttle; use Helius, QuickNode, Triton, Shyft, etc.
- The quote token account must already exist in your wallet (e.g. WSOL ATA). You can create a WSOL ATA by wrapping a tiny amount of SOL first.

---

## Install

```bash
git clone https://github.com/muxprotocol/solana-trading-bot.git
cd solana-trading-bot-master
npm install
cp .env.copy .env
```

Edit `.env` (see [Configuration](#configuration)) and then:

```bash
npm start
```

---

## Configuration

All settings live in `.env`. Copy from `.env.copy` and edit.

### Wallet & Connection

| Var | Example | Notes |
|-----|---------|-------|
| `PRIVATE_KEY` | `base58 / [n,...] / mnemonic / hex` | Accepted formats: base58, JSON array, mnemonic, or 64/128-char hex. Keep secret. |
| `RPC_ENDPOINT` | `https://...` | HTTPS RPC. Use a paid provider. |
| `RPC_WEBSOCKET_ENDPOINT` | `wss://...` | WebSocket RPC. |
| `COMMITMENT_LEVEL` | `confirmed` | `processed`, `confirmed`, or `finalized`. |

### Bot

| Var | Example | Notes |
|-----|---------|-------|
| `LOG_LEVEL` | `trace` | pino log level. |
| `ONE_TOKEN_AT_A_TIME` | `true` | Mutex to process one token at a time. |
| `PRE_LOAD_EXISTING_MARKETS` | `false` | Bulk-fetch OpenBook markets at start (slow). |
| `CACHE_NEW_MARKETS` | `false` | Subscribe to OpenBook markets live. |
| `TRANSACTION_EXECUTOR` | `default` | `default` \| `warp` \| `jito`. |
| `COMPUTE_UNIT_LIMIT` | `101337` | `default` executor only. |
| `COMPUTE_UNIT_PRICE` | `421197` | micro-lamports, `default` executor only. |
| `CUSTOM_FEE` | `0.006` | SOL; for `warp` / `jito` executors. |
| `DRY_RUN` | `false` | If `true`, no transaction is broadcast; decisions are logged only. |
| `MAX_OPEN_POSITIONS` | `3` | Max concurrent positions tracked by the bot. |
| `MAX_DAILY_RAYDIUM_BUYS` | `20` | Successful Raydium buy cap per UTC day. |
| `MAX_DAILY_PUMPFUN_BUY_SOL` | `0.05` | Total SOL budget for pump.fun buys per UTC day. |

### Buy

| Var | Example | Notes |
|-----|---------|-------|
| `QUOTE_MINT` | `WSOL` | `WSOL` or `USDC` (Raydium side). |
| `QUOTE_AMOUNT` | `0.001` | How much quote token to spend per buy. |
| `AUTO_BUY_DELAY` | `0` | ms delay before sending buy. |
| `MAX_BUY_RETRIES` | `10` | Retry count on confirmation failure. |
| `BUY_SLIPPAGE` | `20` | Percent. |

### Sell

| Var | Example | Notes |
|-----|---------|-------|
| `AUTO_SELL` | `true` | Enable auto-sell on wallet balance changes. |
| `AUTO_SELL_DELAY` | `0` | ms delay before sending sell. |
| `MAX_SELL_RETRIES` | `10` | |
| `PRICE_CHECK_INTERVAL` | `2000` | ms between price polls. |
| `PRICE_CHECK_DURATION` | `600000` | ms total TP/SL monitoring window. |
| `TAKE_PROFIT` | `40` | Percent gain. |
| `STOP_LOSS` | `20` | Percent loss. |
| `TRAILING_STOP` | `12` | Percent drop from peak; `0` disables. |
| `TRAILING_STOP_ACTIVATION` | `20` | Only arm trailing after this unrealized gain %. |
| `TAKE_PROFIT_SELL_PERCENT` | `100` | Percent of the bag to sell at TP (rest trails). |
| `SELL_SLIPPAGE` | `20` | Percent. |
| `BUY_COOLDOWN_MS` | `60000` | Ignore re-buys of a mint after a sell. |

### Filters (Raydium)

| Var | Example | Notes |
|-----|---------|-------|
| `USE_SNIPE_LIST` | `false` | When `true`, all filters are bypassed and only mints in `snipe-list.txt` are bought. |
| `SNIPE_LIST_REFRESH_INTERVAL` | `30000` | ms. |
| `FILTER_CHECK_INTERVAL` | `2000` | ms. |
| `FILTER_CHECK_DURATION` | `60000` | ms — total filter monitoring window. |
| `CONSECUTIVE_FILTER_MATCHES` | `3` | Required matches in a row before buying. |
| `CHECK_IF_MUTABLE` | `false` | Reject if token metadata is mutable. |
| `CHECK_IF_SOCIALS` | `true` | Require non-empty socials in metadata URI. |
| `CHECK_IF_MINT_IS_RENOUNCED` | `true` | Require mint authority = null. |
| `CHECK_IF_FREEZABLE` | `false` | Reject if freeze authority set. |
| `CHECK_IF_BURNED` | `true` | Require LP supply = 0 (burned). |
| `CHECK_TOP_HOLDER` | `true` | Reject if the largest non-LP wallet exceeds the cap. |
| `MAX_TOP_HOLDER_PERCENT` | `50` | Percent of supply. |
| `MIN_POOL_SIZE` | `5` | In quote token. |
| `MAX_POOL_SIZE` | `50` | In quote token. Set both to `0` to disable. |

### Modern execution / Jupiter / risk

| Var | Example | Notes |
|-----|---------|-------|
| `DYNAMIC_PRIORITY_FEE` | `true` | Raise CU price from recent prioritization fees. |
| `PRIORITY_FEE_MULTIPLIER` | `1.3` | Applied to the p75 recent fee sample. |
| `MAX_COMPUTE_UNIT_PRICE` | `5000000` | Cap in micro-lamports. |
| `SIMULATE_BEFORE_SEND` | `true` | `simulateTransaction` before broadcast (honeypot / fail-fast). |
| `SKIP_PREFLIGHT` | `true` | `default` executor only. |
| `ENABLE_JUPITER_SELL` | `true` | Use Jupiter when it beats Raydium, and after pump.fun graduation. |
| `JUPITER_API_URL` | `https://lite-api.jup.ag/swap/v1` | Swap API v1. Paid key: `https://api.jup.ag/swap/v1`. |
| `JUPITER_API_KEY` | | Optional `x-api-key`. Required for the paid host. |
| `CIRCUIT_BREAKER_MAX_FAILURES` | `4` | Consecutive failed executions before pause. `0` disables. |
| `CIRCUIT_BREAKER_PAUSE_MS` | `300000` | Pause length after the breaker trips. |

### Copy trade

| Var | Example | Notes |
|-----|---------|-------|
| `ENABLE_COPY_TRADE` | `false` | Mirror buys from tracked wallets via Jupiter. |
| `COPY_WALLETS` | `Addr1,Addr2` | Comma-separated. First balance snapshot is recorded, not copied. |
| `ENABLE_JUPITER_COPY_BUY` | `true` | Master switch for Jupiter copy buys. |

### Cross-DEX arbitrage

| Var | Example | Notes |
|-----|---------|-------|
| `ENABLE_ARBITRAGE` | `false` | Off by default. Needs Jupiter quotes. |
| `ARB_INTERVAL_MS` | `2500` | Scan interval. |
| `ARB_AMOUNT_SOL` | `0.05` | Notional per attempt (input mint of the pair). |
| `ARB_MIN_PROFIT_BPS` | `40` | 40 = 0.40% net of the configured tip buffer. |
| `ARB_SLIPPAGE_BPS` | `50` | Per-leg slippage. |
| `ARB_MAX_DAILY_SOL` | `0.25` | Daily notional cap. |
| `ARB_PAIRS` | `SOL/USDC,SOL/USDT` | Symbols or mint addresses. |
| `ARB_DEX_GROUP_A` | `Raydium,Raydium CLMM,Raydium CPMM` | Cheap/expensive venue group. |
| `ARB_DEX_GROUP_B` | `Whirlpool,Meteora DLMM,Meteora,Pump.fun Amm` | Other venue group. |

Two-leg arb is **not atomic**. If leg 1 fills and leg 2 misses, inventory can sit in the mid pair (e.g. USDC). Keep `ARB_AMOUNT_SOL` small and start with `DRY_RUN=true`.

### pump.fun

| Var | Example | Notes |
|-----|---------|-------|
| `ENABLE_RAYDIUM` | `true` | Master toggle for the Raydium sniper. |
| `ENABLE_PUMP_FUN` | `false` | Master toggle for pump.fun. |
| `PUMP_FUN_BUY_AMOUNT_SOL` | `0.001` | Native SOL per pump.fun buy. |
| `PUMP_FUN_MAX_CURVE_PROGRESS` | `50` | Percent; skip if bonding curve is already filled past this. |

Notes on pump.fun:

- Trades use **native SOL** through the pump.fun bonding curve (no WSOL / Raydium pool). `QUOTE_MINT` / `QUOTE_AMOUNT` do **not** apply.
- A 1% protocol fee is assumed in price calculations; `BUY_SLIPPAGE` and `SELL_SLIPPAGE` are applied on top.
- Once a pump.fun token's bonding curve graduates (`complete = true`), it migrates to Raydium. The bot stops selling via pump.fun at that point; the wallet listener will then route to the Raydium sell path if a pool is known.
- Pool filters (burn, socials, pool size, etc.) **do not** apply to pump.fun — only `PUMP_FUN_MAX_CURVE_PROGRESS` and the snipe list.

---

## Snipe list

Create / edit `snipe-list.txt` with one mint address per line. Set `USE_SNIPE_LIST=true`. Refreshes every `SNIPE_LIST_REFRESH_INTERVAL` ms.

```
# snipe-list.txt
So11111111111111111111111111111111111111112
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

Works for both Raydium and pump.fun paths.

---

## Running

```bash
npm start        # ts-node index.ts
npm run tsc      # type-check only
```

Stop with `Ctrl+C`. Logs print to stdout via pino-pretty.

---

## Transaction executors

### `default`
Standard `sendRawTransaction` + confirmation. You pay priority via `COMPUTE_UNIT_PRICE` × `COMPUTE_UNIT_LIMIT` micro-lamports.

### `warp`
Bundled through `https://tx.warp.id/transaction/execute`. A tip of `CUSTOM_FEE` SOL is sent to the warp fee wallet in a leading transfer.

### `jito`
Sends a Jito bundle to all 5 block-engine regions (mainnet, amsterdam, frankfurt, ny, tokyo). Tip of `CUSTOM_FEE` SOL is sent to a randomly-chosen Jito tip account. Compute-budget instructions are skipped since Jito priority is set via the tip.

---

## Safety checklist

- [ ] Use a **dedicated wallet** funded only with what you're willing to lose.
- [ ] Keep `.env` out of version control (`.gitignore` already excludes it).
- [ ] Start with tiny amounts (`QUOTE_AMOUNT=0.001`, `PUMP_FUN_BUY_AMOUNT_SOL=0.001`).
- [ ] For first runs, set `DRY_RUN=true` to verify behavior before risking funds.
- [ ] Leave `ENABLE_ARBITRAGE=false` until you have confirmed Jupiter quotes in the logs.
- [ ] Use a paid RPC; free endpoints will miss fills.
- [ ] Test `ENABLE_RAYDIUM=false ENABLE_PUMP_FUN=true` or vice versa in isolation first.
- [ ] Monitor logs actively — `LOG_LEVEL=trace` is verbose but informative.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `PRIVATE_KEY is not set` | `.env` missing / path wrong. |
| `... token account not found in wallet` | You haven't created a WSOL (or USDC) ATA yet. Wrap a tiny amount of SOL first. |
| No pools detected | RPC too slow / filters too strict / wrong `COMMITMENT_LEVEL`. |
| Buys never confirm | Priority fee too low or RPC drops txs; try `warp` / `jito` executor. |
| `Curve progress too high` | Increase `PUMP_FUN_MAX_CURVE_PROGRESS` or loosen. |
| `Bonding curve complete` | Token already graduated to Raydium; pump.fun path can't trade it. |

---

## Project layout

```
.
├── bot.ts                       Core Bot (buy/sell for both DEXes)
├── index.ts                     Entry point & event wiring
├── arbitrage/                   Cross-DEX Jupiter arb engine
├── risk/                        Circuit breaker + position book
├── cache/
│   ├── market.cache.ts
│   ├── pool.cache.ts
│   ├── pumpfun.cache.ts         pump.fun bonding curve state cache
│   └── snipe-list.cache.ts
├── filters/                     PoolFilters + individual filters
├── helpers/
│   ├── constants.ts             Env var parsing
│   ├── jupiter.ts               Jupiter Swap API v1 client
│   ├── exit-strategy.ts         TP / SL / trailing stop
│   ├── priority-fee.ts          Dynamic compute unit price
│   ├── simulation.ts            Pre-send transaction simulation
│   ├── liquidity.ts             createPoolKeys for Raydium
│   ├── logger.ts
│   ├── market.ts                MinimalMarketLayoutV3
│   ├── pumpfun.ts               pump.fun program + layout + ix builders + pricing
│   ├── promises.ts
│   ├── token.ts                 WSOL / USDC
│   └── wallet.ts
├── listeners/listeners.ts       WebSocket subscriptions
├── transactions/
│   ├── default-transaction-executor.ts
│   ├── warp-transaction-executor.ts
│   └── jito-rpc-transaction-executor.ts
├── .env.copy                    Template
├── snipe-list.txt               Whitelist (optional)
└── tsconfig.json
```

---

## License

MIT — see `LICENSE.md`.

## Credits

- Original Raydium sniper by Filip Dundjer / warp.id.
- pump.fun integration layered on top.
- Built on `@solana/web3.js`, `@solana/spl-token`, `@raydium-io/raydium-sdk`, `@metaplex-foundation/mpl-token-metadata`.
