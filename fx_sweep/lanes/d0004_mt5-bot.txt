# MT5 Trading Bots — Telegram/Discord Control & Copy Bridges
Lane: `mt5-bot` · keyword "MT5 trading bot" · focus: Telegram or Discord controlled MT5 bots, copy bridges. Run `wf_71a518c957daaf7c` (script `.myterminal/workflows/saved/mtfx.js`), 2026-10-04.

## Method and a hard caveat
This path is **read-only and network-blocked**: `curl`, `wget`, `gh`, `nc`, `python3` and `git ls-remote` are all refused by the tool allowlist (only local reads run), and there is **no MT5/forex corpus on disk** to mine — the only prior research corpus here (`gh_search/`, `verify2/`) is the CEX-listing-sniper lane, and a repo-wide grep for `mt5|metatrader|mql5|mql4` hits nothing but the workflow script itself. So this lane could **not** be populated from GitHub Search/Repo API responses the way the sibling CEX report was.

What follows is therefore a **knowledge-based map of the lane, not an API-verified repo survey**. Star counts/dates are deliberately omitted; treat every named repo as *needs live re-verification* (exact owner/name, license, last push) before it enters a final report. The structural findings and the risk section are the parts I'd stand behind.

## Key structural findings (the lane is shaped differently from the CEX/EA lanes)
1. **There is no open MT5 server API.** MetaQuotes ships no open REST/socket API for MT5. Every "Telegram/Discord-controlled MT5 bot" in open source is really glue over one of two chokepoints: (a) the **official `MetaTrader5` Python package**, which talks to a *running terminal* over local IPC and is **Windows-only, closed-source freeware**, or (b) an **in-terminal EA** acting as an RPC server that an outside process drives.
2. **Consequence:** the Telegram/Discord MT5 space is mostly **small DIY scripts** (`python-telegram-bot` / `telegram` / `discord.py` wrapping `MetaTrader5.order_send()`), not a few famous high-star projects. Signal in → parse → `order_send()`. There is no dominant open-source "MT5 Telegram bot" the way `freqtrade` dominates the crypto-Telegram lane.
3. **"Copy bridge" is three different things**, and the lane conflates them:
   - **Broker/server copy** — MQL5 Signals, MetaQuotes, broker-provided. Closed, but it *is* the free default most users actually use.
   - **MT5↔MT5 trade copier EA** — master/slave EAs relaying orders via terminal global variables, files, named pipes, sockets, or a manager API. Lots of low-quality open repos; the *good* free one (FX Blue Personal Trade Copier) is closed freeware.
   - **MT5↔external-process bridge** — ZeroMQ/REST/Redis/MQTT/socket, so Python/Node can read and trade. This is where the genuinely reusable open source lives (and it overlaps the `broker-api`, `tradingview` and `copy-trading` lanes).
4. **Discord is near-empty.** Telegram has some traction (parsers + signal relays); Discord MT5 control is almost entirely one-off personal glue with no notable open project. Treat "Discord MT5 bot" as a market gap, not a category with picks.

## Representative open source (unverified — re-check before publishing)
Backbone / bridges (highest reuse value):
- **darwinex / dwx-zeromq-connector** — MIT. The classic MT4/MT5 ↔ Python bridge over ZeroMQ; EA on the terminal side, Python client on the other. Still the reference for headless control. (Verify whether the maintained branch covers MT5 or is MT4-only.)
- **dingmaotu / mql-zmq** (plus `mql4-lib`, `mql-redis`, `mql-sqlite3`) — native MQL bindings that let an MT5 EA speak ZeroMQ/Redis directly, i.e. the building block under most custom bridges.
- **vdemydiuk / mtapi (MtApi) + mtapi5** — Apache-licensed MQL/.NET bridge exposing MT4/MT5 over REST/JSON; useful but low-activity.
- **MetaQuotes `MetaTrader5` Python package** — the substrate, not a bot; free, closed, Windows. Must be called out because every "MT5 Telegram bot" README quietly depends on it.
- **`mt5linux`** (PyPI) — RPyC shim to run the `MetaTrader5` Python API from Linux. Verify owner/maintenance.
- **`gmag11`-style MetaTrader5-Docker images** — run MT5 under Wine for a headless VPS bridge; verify the exact repo.

Bot / EA frameworks that get externally driven:
- **EA31337 / EA31337** — one of the few substantial open MT4/MT5 EA codebases; usable as the execution engine a Telegram/Discord front-end commands.

Alert / signal relay (the "front half" of a signal→broker pipe):
- **TBXark / TradingView-Webhook-Bot** — webhook receiver that fans alerts out to Telegram/Discord; the relay half of "TradingView alert → MT5 order".
- General glue: `python-telegram-bot`, `telethon`/`pyrogram`, `discord.py`, `discord-webhook`.

Adjacent but frequently cited as the architecture to copy:
- **freqtrade** — Telegram-controlled bot with REST API. **Crypto, not MT5.** Include only as the design reference, clearly labeled.

Closed baselines worth naming so the "open source" gap is honest:
- **MQL5 Signals** (built into MT5, broker-hosted copy) — the free default.
- **FX Blue Personal Trade Copier** — free, closed, MT4/MT5, the de-facto copier answer.
- Commercial copiers: EarnForex Trade Copier, TSCopyTrader, SocialTraderTools, CopyMaster; paid "MT5→Telegram signal sender" EAs on the MQL5 Market.

## Where open source is weak (the lane's real finding)
- No credible OSS MT5 Telegram **trade** bot with the polish of the CEX-lane picks — mostly demos and one-person scripts.
- Discord control: effectively unfilled.
- Robust MT5↔MT5 copiers: dominated by free-but-closed (FX Blue) or paid tools; open ones are fragile (global variables / file polling, no symbol/volume reconciliation, no slippage handling).
- Everything is Windows/terminal-bound, so "free + headless + reliable" is the hard, under-served combination.

## Risk / anti-pattern flags for this lane
- **Compiled-EA / DLL installers** and `curl | bash` "one-line installers" — the top malware vector in MT4/MT5 repos (keyloggers, terminal-credential theft, "nulled" cracked EAs).
- **"Send your (investor) password"** tools — investor password leaks account performance; anything asking for the **master** password is full account control.
- **Signal-seller funnels**: keyword-stuffed "AI/quant MT5 bot" READMEs that lead to a paid Telegram channel; description promises "MT5 bot", code doesn't touch MT5.
- **Keyword collisions**: many `mt5` hits will actually be **MT4** EAs, crypto bots, or generic "MetaTrader" wrappers; filter on real `order_send`/`OrderSend`/terminal-IPC calls.

## Queries to actually close this lane (run where network is available)
`mt5 telegram bot` · `metatrader5 telegram` · `telegram signal to mt5` · `mt5 discord bot` · `mt5 trade copier` · `metatrader5 python bot` · `metatrader bridge zmq` · `mql5 zmq` · `mt5 rest api` · `mt5 websocket` · `metatrader5 docker` · `copy trading mt5` · `expert advisor telegram` · `mt5 signal copier` — then record stars/forks/license/last-push/pushed from the Repo API and READMEs, exactly as the CEX lane did.

Confidence: structural findings and risk list = high; the named-repo list = **medium/unverified** (no API access on this path) and must be re-checked before it is merged as fact.