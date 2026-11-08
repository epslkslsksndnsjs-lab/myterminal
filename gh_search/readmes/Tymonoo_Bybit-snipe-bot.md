# Bybit Snipe Bot

A  Telegram sniping bot for Bybit USDT-M futures.  
The bot monitors selected Telegram channels for new token listings or delisting and automatically opens LONG positions with built-in risk management.

## Features

- Real-time monitoring of Telegram channels for listing signals
- Automatic detection of tickers (formats: `(BTC)` or `XXXUSDT`)
- Opens **LONG** positions with isolated margin
- Automatic Stop Loss at -50% and Take Profit at +100%
- Continuous unrealized P&L updates every 2 seconds
- Concurrent processing of multiple tickers
- Secure Bitget API authentication using HMAC-SHA256
- Detailed logging

## Monitored Sources

The bot currently uses the following sources for detecting new listings:

- **BWEnews** — https://t.me/BWEnews (fastest Chinese crypto news channel)
- **AstronomicaNews** — https://t.me/AstronomicaNews
- **Junction Bot** (@junction_bot) — used for automatic message forwarding from multiple sources to a single chat

**Setup recommendation:**
1. Add your bot to the channels above (or to a private group).
2. Use **@junction_bot** to forward messages from BWEnews and AstronomicaNews into one clean chat.
3. Add your sniping bot to that final chat (via BotFather setup).

This setup ensures reliable and fast signal reception.
