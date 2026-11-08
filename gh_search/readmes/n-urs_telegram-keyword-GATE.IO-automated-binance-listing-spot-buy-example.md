**Project Title**

telegram-keyword-GATE.IO-automated-binance-listing-spot-buy-example

## Overview

This project provides a Telegram bot that listens to specified channels for messages announcing new futures launches, spot listings, and Upbit listings, then automatically executes market buy orders on Gate.io. After successful trades, it retrieves market capitalization data from CoinMarketCap and CoinGecko. The bot is designed for automation and quick execution with configurable parameters.

## Features

* Listens for three types of listing messages on Telegram:

  1. Futures launch announcements containing "futures will launch"
  2. Spot listing notifications containing "will list"
  3. Upbit listings containing "UPBIT LISTING" and "KRW"
* Cleans and formats ticker symbols for Gate.io compatibility
* Executes market buy orders on Gate.io with adjustable target USDT allocations and cooldown periods
* Fetches additional asset info:

  * Market cap from CoinMarketCap
  * Market cap from CoinGecko
  * Contract addresses from CoinMarketCap if needed
* Logs detailed execution steps and errors
* Configurable via environment variables in a `.env` file

## Prerequisites

* Python 3.8 or above
* Git
* Gate.io account with API key & secret
* CoinMarketCap API key
* Telegram account with API ID, API hash, and phone number

## Installation

1. Clone this repository:

   ```bash
   git clone https://github.com/yourusername/telegram-keyword-GATE.IO-automated-binance-listing-spot-buy-example.git
   cd telegram-keyword-GATE.IO-automated-binance-listing-spot-buy-example
   ```
2. Create and activate a virtual environment:

   ```bash
   python3 -m venv venv
   source venv/bin/activate   # Mac/Linux
   venv\\Scripts\\activate  # Windows
   ```
3. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

## Configuration

1. Copy the example environment file and fill in your credentials:

   ```bash
   cp config.env.example config.env
   ```
2. Set the following variables in `config.env`:

   ```ini
   TG_API_ID=<Your Telegram API ID>
   TG_API_HASH=<Your Telegram API Hash>
   TG_PHONE=<Your Telegram Phone Number>
   TARGET_CHAT=<Telegram chat ID to send contract addresses>
   CHANNELS=<Comma-separated Telegram channel IDs>

   GATE_API_KEY=<Your Gate.io API key>
   GATE_API_SECRET=<Your Gate.io API secret>

   CMC_API_KEY=<Your CoinMarketCap API key>
   ```
3. Adjust constants in the script if desired:

   * `INITIAL_TARGET_USDT`: Total USDT to allocate per announcement
   * `COOLDOWN_PERIOD_SECONDS`: Minimum seconds between trades for the same asset
   * `FUTURES_MESSAGE_DIVISOR`, `UPBIT_MESSAGE_DIVISOR`: Divisors to split allocations

## Usage

Run the bot:

```bash
python bot.py
```

The bot will connect to Telegram, listen for new messages in configured channels, and automatically process and trade based on message content.

## Logging

The bot uses Python's `logging` module. By default, logs are output at the INFO level. Adjust `logging.basicConfig(level=logging.INFO)` in the script to change verbosity.

## Contributing

Contributions are welcome! Please open issues or submit pull requests for bug fixes, improvements, or feature requests.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/YourFeature`)
3. Commit your changes (`git commit -m "Add your feature"`)
4. Push to the branch (`git push origin feature/YourFeature`)
5. Open a pull request

## License

This project is open source under the MIT License. See [LICENSE](LICENSE) for details.

## Disclaimer

Trading cryptocurrencies carries risk. This bot is provided "as is" without warranty of any kind. Use at your own risk.
