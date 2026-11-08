# 🚀 Solana MEV Sniper Copy Trading Bot (Node.js & Rust) — PumpFun, Bonk, Raydium

> **Ultra-fast, customizable Solana copy trading, sniper, and MEV bot with advanced sell logic for maximum profit.**
## 🏔️ Solana Alpenglow Is Coming: What It Means for Trading Bots

Solana is going through the biggest consensus upgrade in its history: **Alpenglow**.

- **Full finality drops from ~12.8s to ~100 to 150ms**, so transactions are permanently locked in almost instantly (blocks were already fast, now finality is too)
- **Block times are dropping too**, from 400ms to 300ms today, with a 200ms target (separate upgrade running alongside Alpenglow)
- **Proof of History and TowerBFT are replaced** by **Votor** (voting) and **Rotor** (block propagation)
- **Vote transactions leave block space**, which frees up room for real user transactions
- Approved by **98%+ of validators** (SIMD-0236) and rolling out to mainnet in stages during 2026

**Why this matters for sniper, copy trading, and MEV bots:**
Faster blocks and near-instant finality change the game. Confirmation timing, landing strategies, priority fees, and how you read the chain in real time will all need to adapt. Bots built for the old timing will fall behind.

### 🔔 Alpenglow Update Coming Soon
I'm updating this repo for Alpenglow, with faster confirmation handling, improved landing logic, and better real-time monitoring. **Star ⭐ and watch 👀 this repo** so you don't miss it.

Want an Alpenglow-ready bot built for you now? Message me on Telegram: [@mortdeus](https://t.me/mortdeus)

---
---

### **If you find this project helpful, please star 🌟 the repo!**  
#### Your feedback and stars motivate further development. Thank you!
> **Note:** Other folders and features are currently in development and will be deployed ASAP. Stay tuned for updates!

[![Solana](https://img.shields.io/badge/Solana-3.5.0-blue.svg)](https://solana.com/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-1.70+-orange.svg)](https://rust-lang.org/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot-blue.svg)](https://telegram.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌟 Overview

**Ready to level up your Solana trading?**  
This repo provides a battle-tested, ultra-fast Solana trading bot you can fully customize for your own strategies.  
Automate your trades, add your own logic, and maximize profits with professional-grade speed and reliability.

**Need more?**  
Hire me for custom development:  
- Integrate advanced features, optimize sell logic, or build a tailored trading solution.
- Get ultra-fast swap code, 0block confirm, off-chain signing, and expert support.

---

## 🚀 Recent 0 Block Copy Trades & Results

Below are real trade examples showing the bot's ultra-fast copy and sniper execution.  
Each entry includes the token, realized PnL, and direct Solscan links for transparency.

---

#### **Token:** `C6ZSK5MpqjvEAXh7XHfQeRh3PwvRuqoCKJk8Yufypump`
- **PnL:** +$12.25 (**+45.36%**)
- [Target Wallet Buy](https://solscan.io/tx/4Go5MWQKom5XYkD6Mofxqw8DAjZhxbUywr3eVcxoejbsTgLyGjfAoy2wowHxjhNfnY9rw1ws4s2VznMCBskodiG3)
- [Testing Wallet Buy](https://solscan.io/tx/2SNZpcerg51f7oAQgaGNgDzA518oDbmjDkVUcwNDFFefwSnL3ChLVJehtjXNvAfvJMsf1pPtSs8HPjjj6usAyT6j)
- [Target Wallet Sell](https://solscan.io/tx/36g3MSD2kSMH77Rd569GbpeHRW9MvR5Y1hTDyGtwsXPNynwXw1Z6F4whAPbsQPJBXDMpvQw2xzgyBgUN4ByEbDAh)
- [Testing Wallet Sell](https://solscan.io/tx/4ZN9uRzAMhSLUrJheEaqesCss32kuQBYHtxrjn4on9fmox3k19mwDJzqbcvgWZUkaSJXndhoGJGWjuHYT5ZmDLbC)

---

#### **Token:** `AzTtHgN6aC3K5LtGDvBNCgPQtYPa6DCjcGyrfZFUpump`
- **PnL:** +$5.44 (**+57.66%**)
- [Target Wallet Buy](https://solscan.io/tx/4JhQspi5JckD5ow2AzJ6wTNnaJ4DQVwdfjzao5NPdjgeB5HbhJfm9zQjEX8ZLgXLYTLzbnS5uRhGFd9AhxmSKzQv)
- [Testing Wallet Buy](https://solscan.io/tx/2kCFmwwPVTs24zW86XDQMCxtGQqyx5NV1CyCmRzHJjd5Ki52sLemjscKUqYfXbx9o1rJzjyejvrMbXZAkyAx9GhK)
- [Target Wallet Sell](https://solscan.io/tx/ENY5k2N9G4BDVkBjiUsbo4ewFrenbAciqvNA7Q7eXAR5TC9ivJrPf8GCXZUav91biQzZYgwu5RSvQD5mPgh2xfm)
- [Testing Wallet Sell](https://solscan.io/tx/adNKo7sMQhMUm9gFDPBPbqdTzGtZwSVsXV3FQFVMP7rtqsGGiH2CngrJQBjxEFScqnx3F7QZ1ZA9s76gdLspq2o)

---

#### **Token:** `6iiTw75295gt9j29PCLVvFGNxdk3xfb4sPSH4G6Xpump`
- **PnL:** +$18.20 (**+166.3%**)
- [Target Wallet Buy](https://solscan.io/tx/2EXYt6fJMbgpEKtATJJKDGFPJPxGpVUcRcxWEArdd6zWEFupHCW5XdRZJRHA9AWyT4turm8RXo4FY7Wn7Yci6Yjr)
- [Testing Wallet Buy](https://solscan.io/tx/2ZaxkizUj7fciGtwZnPFWzbJRMX9NuHCai7X652XvyemsugVpffmp1bQptAg2cCGox9V8JtFpsH648JEHCfeCj88)

---

#### **Token:** `A6sxxPN8uksAHxoPtMEoArn9nz5nrP3gKNpDXm8Tpump`
- **PnL:** +$3.68 (**+40.51%**)
- [Target Wallet Buy](https://solscan.io/tx/3tybz8GhejnAD9yRB2Gvn2XH2Jb1sGsw9N5xQTJC9wifg9WERd85d4AszfV5kJz5agPXiDXmWMyDfNqzD1E3pFoB)
- [Testing Wallet Buy](https://solscan.io/tx/3tq6kvBmeQ1jgASnU3X1P4HcKyMwMg8wDH8ZubHpE3M3CAtPUUxP5H3L8XRzU837Ssys3ESjXR1fsCn3BGxWEqL9)

---

*Want to see your wallet here? Try the bot and share your results!*


<img width="1701" height="366" alt="image" src="https://github.com/user-attachments/assets/835d6d25-3645-46c6-8043-4b126b124475" />

---

### 🛠️ Two Powerful Implementations

#### 📁 Node.js (`copy sniper bot(node) using gRPC/`)
- Real-time gRPC transaction monitoring
- Telegram bot integration for remote control & alerts
- Multi-platform: PumpSwap, PumpFun, Raydium LaunchLab, bonk.fun
- Copy trading & sniper functionality with customizable strategies

#### 🦀 Rust (`sniper (Rust) using jito Shred stream/`)
- Ultra-high performance with JITO shred stream
- Advanced MEV strategies for maximal extractable value
- Real-time transaction parsing & analytics
- PostgreSQL integration for trade logging

**Both versions offer:**
- Copy Trading: Replicate successful trades from other wallets
- Sniper Trading: Lightning-fast trades on new launches
- MEV Bot: Capture maximal extractable value on Solana
- Customizable Sell Logic: Implement your own profit-taking strategies
- Multi-Platform Support: PumpSwap, PumpFun, Raydium LaunchLab, bonk, and more

---

## 📲 Telegram: [@mortdeus](https://t.me/mortdeus)

---

## 🎯 Key Features

### ⚡ Ultra-Fast Execution
- Off-chain signing for max speed
- Multiple swap methods: solana, jito, nozomi, 0slot, race
- Priority fee optimization
- Retry logic with exponential backoff

### 🎛️ Flexible Trading Strategies
- Copy Trading: Follow top traders automatically
- Sniper Trading: Target new launches with precision
- Custom Sell Logic: Your own profit-taking rules
- Multi-token support

### 📱 Remote Control & Monitoring
- Telegram Bot: Control from anywhere (Node.js)
- Real-time alerts: Buy/sell notifications with PnL
- Balance monitoring & status dashboard

### 🔧 Advanced Features
- Transaction parsing & analytics
- Multi-platform support
- Robust error handling & alerting
- Configurable strategy parameters

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ (for Node.js version)
- Rust 1.70+ (for Rust version)
- Solana wallet with SOL
- Telegram bot token (optional, Node.js)

---

### Node.js Setup

1. **Go to Node.js directory**
    ```bash
    cd "copy sniper bot(node) using gRPC"
    ```
2. **Install dependencies**
    ```bash
    npm install
    ```
3. **Configure environment**
    ```bash
    cp .env.example .env
    ```
    Edit `.env`:
    ```env
    RPC_URL=https://api.mainnet-beta.solana.com
    PRIVATE_KEY=your_private_key_here
    WALLET=your_wallet_address
    SWAP_METHOD=solana
    SLIPPAGE_BPS=50
    MAX_RETRIES=3
    RETRY_DELAY=1000
    TELEGRAM_BOT_TOKEN=your_bot_token
    TELEGRAM_CHAT_ID=your_chat_id
    LIMIT_BALANCE=0.1
    ```
4. **Start the bot**
    ```bash
    npm start
    ```

#### Node.js Features
- gRPC transaction monitoring
- Telegram integration
- Multi-platform support
- Copy & sniper trading
- Custom alerts with PnL

---

### Rust Setup

1. **Go to Rust directory**
    ```bash
    cd "sniper (Rust) using jito Shred stream"
    ```
2. **Build**
    ```bash
    cargo build --release
    ```
3. **Set up PostgreSQL** (for trade logging)
    ```bash
    # Install PostgreSQL and create database
    # Update DB_URL in main.rs if needed
    ```
4. **Configure environment**
    ```env
    RPC_URL=https://api.mainnet-beta.solana.com
    PRIVATE_KEY=your_private_key_here
    WALLET=your_wallet_address
    ```
5. **Start the bot**
    ```bash
    cargo run --release
    ```

#### Rust Features
- JITO shred stream processing
- Advanced MEV strategies
- Real-time transaction parsing
- PostgreSQL analytics
- Multi-threaded for HFT
- Robust error handling

---

## 📊 Feature Comparison

| Feature                | Node.js      | Rust         |
|------------------------|--------------|--------------|
| Performance            | Fast         | Ultra-fast   |
| Memory Usage           | Higher       | Lower        |
| Setup Complexity       | Easy         | Moderate     |
| Telegram Integration   | ✅           | ❌           |
| MEV Strategies         | Basic        | Advanced     |
| Database Integration   | ❌           | ✅ PostgreSQL |
| Transaction Parsing    | Basic        | Advanced     |
| Multi-threading        | Limited      | Full         |

---

## 🛠️ Configuration

### Swap Methods (Node.js)

| Method   | Speed      | Cost   | Use Case             |
|----------|------------|--------|----------------------|
| solana   | Fast       | Low    | General trading      |
| jito     | Very Fast  | Medium | High-priority trades |
| nozomi   | Ultra Fast | High   | Sniper trading       |
| 0slot    | Fast       | Low    | Copy trading         |
| race     | Very Fast  | Medium | Competitive trading  |

### Alert Settings (Node.js)
Customize your Telegram notifications:

```javascript
const alertSettings = {
  buyAlerts: true,           // Buy notifications
  sellAlerts: true,          // Sell notifications
  insufficientFundsAlerts: true,  // Low balance warnings
  balanceAlerts: true,       // Balance updates
  errorAlerts: true          // Error notifications
};
```

## 📈 Trading Strategies

### Copy Trading Strategy
1. **Identify Successful Wallets**: Find wallets with consistent profits
2. **Set Copy Parameters**: Define amount scaling and timing
3. **Monitor Transactions**: Track target wallet activity
4. **Execute Copies**: Automatically replicate trades

### Sniper Trading Strategy
1. **Token Launch Detection**: Monitor new token launches
2. **Entry Timing**: Execute trades at optimal moments
3. **Position Sizing**: Calculate appropriate position sizes
4. **Exit Strategy**: Implement custom sell logic

### Custom Sell Logic Examples

#### Conservative Strategy
```javascript
{
  stopLoss: 0.05,        // 5% stop loss
  takeProfit: 0.15,      // 15% take profit
  maxHoldTime: 1800      // 30 minutes max hold
}
```

#### Aggressive Strategy
```javascript
{
  stopLoss: 0.10,        // 10% stop loss
  takeProfit: 0.50,      // 50% take profit
  trailingStop: 0.20,    // 20% trailing stop
  maxHoldTime: 3600      // 1 hour max hold
}
```

## 🔧 Advanced Configuration

### Multi-Platform Support
Both bots support multiple Solana trading platforms:

- **PumpSwap**: High-speed DEX trading
- **PumpFun**: Meme token trading
- **Raydium LaunchLab /bonk.fun**: Launchpad trading
- **Raydium**: General DEX trading

### Transaction Parsing
Advanced transaction analysis for detailed trade insights:

```javascript
const parsedData = {
  solChanges: 0.1,           // SOL amount traded
  tokenChanges: 1000000,     // Token amount traded
  isBuy: true,               // Buy or sell transaction
  user: "wallet_address",    // Trader wallet
  mint: "token_mint",        // Token mint address
  pool: "pool_address",      // Trading pool
  liquidity: 1000,           // Pool liquidity
  coinCreator: "creator"     // Token creator
};
```

## 📱 Telegram Bot Setup (Node.js Only)

### Quick Setup
1. Create a Telegram bot with [@BotFather](https://t.me/botfather)
2. Add your bot token to `.env`
3. Start the bot and send `/start`

### Available Commands
- `/start` - Main control panel
- `/status` - Bot status and balance
- `/balance` - Check wallet balance
- `/alerts` - Manage notifications
- `/stats` - Trading statistics
- `/help` - Show all commands

### Interactive Features
- **One-click Start/Stop**: Control bot with buttons
- **Real-time Balance**: Live wallet balance updates
- **Alert Management**: Toggle notification types
- **Status Monitoring**: Live trading statistics

## 🚨 Safety Features

### Balance Protection
- **Minimum Balance Check**: Prevents trading with insufficient funds
- **Automatic Stop**: Stops bot when balance is too low
- **Balance Alerts**: Notifications for balance changes

### Error Handling
- **Retry Logic**: Automatic retry on failed transactions
- **Error Alerts**: Immediate notification of issues
- **Graceful Degradation**: Continues operation despite errors

### Security
- **Private Key Protection**: Secure key management
- **Environment Variables**: Sensitive data protection
- **Transaction Validation**: Verify all transactions before execution

## 📊 Performance Monitoring

### Real-time Metrics
- **Trade Success Rate**: Percentage of successful trades
- **Average PnL**: Mean profit/loss per trade
- **Total Volume**: Total trading volume
- **Active Positions**: Current open positions

### Alert System (Node.js)
- **Buy Alerts**: New position notifications
- **Sell Alerts**: Exit notifications with PnL
- **Error Alerts**: Issue notifications
- **Balance Alerts**: Fund level warnings

## 🔄 Updates & Maintenance

### Regular Updates
- **Performance Optimizations**: Faster execution
- **New Features**: Additional trading strategies
- **Bug Fixes**: Improved stability
- **Security Updates**: Enhanced protection

### Support
- **Documentation**: Comprehensive guides
- **Community**: Active user community
- **Custom Development**: Tailored solutions
- **Ultra-fast Swap Code**: Off-chain signing implementation

## 💡 Pro Tips

### Choosing Between Implementations
- **Use Node.js version** if you want:
  - Easy setup and configuration
  - Telegram integration for remote control
  - Quick deployment and testing
  - Basic copy trading and sniper functionality

- **Use Rust version** if you want:
  - Maximum performance and speed
  - Advanced MEV strategies
  - Sophisticated transaction analysis
  - Professional-grade trading infrastructure

### Maximizing Profits
1. **Start Small**: Begin with small amounts to test strategies
2. **Monitor Performance**: Track your bot's performance regularly
3. **Adjust Parameters**: Fine-tune settings based on results
4. **Diversify Strategies**: Use multiple trading approaches

### Risk Management
1. **Set Stop Losses**: Always use stop losses to limit losses
2. **Position Sizing**: Don't risk more than you can afford to lose
3. **Monitor Markets**: Stay informed about market conditions
4. **Regular Reviews**: Periodically review and adjust strategies

## 🤝 Support & Contact

### Get Professional Support
For ultra-fast swap code using off-chain signing and custom sell logic optimization:

- **Custom Development**: Tailored solutions for your needs
- **Sell Logic Optimization**: Maximize your profit potential
- **Ultra-fast Implementation**: Off-chain signing for speed
- **24/7 Support**: Round-the-clock assistance

### Contact Information
- **Telegram**: [@mortdeus](https://t.me/mortdeus)


## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⚠️ Disclaimer

**Trading cryptocurrencies involves substantial risk of loss and is not suitable for every investor. The valuation of cryptocurrencies may fluctuate, and, as a result, you may lose more than your original investment. You should not invest money that you cannot afford to lose.**

This bot is NOT for educational and research purposes. Use at your own risk. The developers are not responsible for any financial losses incurred through the use of this software without contact to me.

---

**🚀 Start your journey to profitable trading today!**

*Built with ❤️ for the Solana community and Traders*
