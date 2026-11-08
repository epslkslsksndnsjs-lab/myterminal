# Bybit Listing Notifier Bot

This Telegram bot instantly notifies about new Bybit spot listings. It's built according to best practices outlined in bybit-listing-guide.md and supports robust, real-time listing detection and notification. See bybit-listing-guide.md for architectural rationale.

## Features
- Polls Bybit REST API for new spot pairs every 5–10 seconds
- Sends Telegram message immediately upon detecting a new listing
- Persists known listings for reliability across bot restarts (SQLite/file)
- Robust error handling & notification

## Setup
1. Clone repository and install requirements
2. Fill in .env with
    - `TELEGRAM_BOT_TOKEN` (from BotFather)
    - `TELEGRAM_CHAT_ID` (for the channel/group/user to notify)
3. Run `python main.py`

4. To run tests: `pytest test_main.py` (requires pytest)
5. Export database:
   - `python export_db.py` for CSV
   - `python export_db.py json` for JSON
6. For logging settings, set BOT_LOGLEVEL/BOT_LOGFILE in .env
7. Deploy to cloud via Docker:
   - Build image: `docker build -t bybit-notify-bot .`
   - Run: `docker run --env-file .env -v $(pwd)/symbols.db:/app/symbols.db bybit-notify-bot`

## Advanced
- Dry-run/testing mode and further configurations coming soon.
- See deploy_cloud.sh for deployment script sample.

## Files
- `main.py`: Bot logic
- `bybit-listing-guide.md`: Full specs and rationale
- `README.md`: This file

## References
- [Bybit V5 API Docs](https://bybit-exchange.github.io/docs/v5/market/instrument)
- [Telegram Bot API Docs](https://core.telegram.org/bots/api)
