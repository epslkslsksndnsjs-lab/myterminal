# New Listing Announcement Crypto Trading Bot

This is a cryptocurrency trading bot designed to detect new coin listing announcements on Binance and immediately
purchase the announced coin on a different exchange (currently configured to Poloniex).

The bot capitalizes on the observation that coins announced for listing on Binance often experience significant price
surges shortly after the announcement. By purchasing the asset on another exchange where it is already tradable (e.g.,
Poloniex), users aim to profit from this volatility before the Binance listing goes live.

---

## Key Features

- **Real-Time Announcement Scanning**: Continuously monitors Binance’s official announcements for phrases like "will
  list" to detect new coin listings.
- **Automated Purchasing**: Instantly places market buy orders on Poloniex for detected coins, using a configurable USDT
  amount.
- **Dynamic Exit Strategies**:
    - **Stop-Loss**: Automatically sells if the price drops below a user-defined percentage (e.g., 1%) to limit losses.
    - **Trailing Take-Profit**: Adjusts profit targets upward as the price rises, locking in gains while allowing
      further upside.
- **Duplicate Prevention**: Skips coins already in the portfolio to avoid redundant purchases.
- **Test Mode**: Simulates trades without real funds, providing risk-free testing with mock order results.
- **Database Tracking**: Logs all trades, exit targets, and outcomes for review.

---

## Configuration

Rename `appsettings.example.json` to `appsettings.json` and customize the bot:

```txt
"BotConfig": {
  "BuyAmount": 20,     // USDT amount to spend per coin  
  "StopLoss": 1,       // 1% price drop triggers a sell  
  "TakeProfit": 1,     // 1% price rise updates profit targets  
  "TestMode": true     // Enable paper trading (no real funds)  
}
```

## How It Works

- **Announcement Detection**: The bot polls Binance’s announcement API every few seconds.
- **Symbol Extraction**: Uses regex to parse coin tickers (e.g., SOL from "Solana (SOL)") from the announcement text.
- **Order Execution**: For each symbol, it checks the database to avoid duplicates, then places a market buy order on
  Poloniex.
- **Exit Management**: A secondary service monitors prices and executes sells if stop-loss or trailing take-profit
  thresholds are met.

## Get started

- To start running the trading bot, configure your `appsettings.json` and then run `./build.ps1` or `./build.sh`.
- Check Docker `app` logs for activity.
- On start the script builds migrations locally before copying over the directory to Docker so if you're building
  manually, remember to run the migrations first.

## Looking for No-Code Trading Bots?

Check out **[Aesir](https://aesircrypto.com)**, one of the
fastest [crypto trading bot platforms](https://aesircrypto.com) that
makes building trading bots a breeze.