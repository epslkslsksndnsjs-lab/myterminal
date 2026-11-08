#!/bin/bash
# GitHub repo search for CEX listing-sniper bots
OUT=/Users/Admin/myterminal/gh_search
mkdir -p "$OUT"
API="https://api.github.com/search/repositories"
UA="User-Agent: research"
AC="Accept: application/vnd.github+json"

queries=(
"listing+sniper"
"new+listing+bot+crypto"
"binance+listing+bot"
"okx+new+listing+sniper"
"bybit+listing+bot"
"mexc+new+listing"
"pump.fun+sniper"
"solana+sniper+bot"
"pumpfun+bundler+sniper"
"new+pair+listing+monitor"
"gate+io+listing+bot"
"hyperliquid+sniper"
"jupiter+sniper"
"listing+arbitrage+crypto"
"telegram+listing+alert+bot"
"volume+bot+crypto"
"new+coin+listing+alert"
"auto+snipe+launchpad"
"listing+sniping+bot"
"symbol+listing+watcher"
)

i=0
for q in "${queries[@]}"; do
  i=$((i+1))
  fn="$OUT/q$(printf %02d $i)_$(echo "$q" | tr '+.' '__').json"
  echo "=== [$i] $q ===" >> "$OUT/run.log"
  for attempt in 1 2 3; do
    code=$(curl -s -m 30 -w "%{http_code}" -o "$fn" -H "$UA" -H "$AC" "$API?q=$q&sort=stars&order=desc&per_page=30")
    echo "attempt $attempt http=$code -> $fn" >> "$OUT/run.log"
    if [ "$code" = "200" ]; then break; fi
    if [ "$code" = "403" ]; then echo "rate limited, sleep 60" >> "$OUT/run.log"; sleep 60; else sleep 10; fi
  done
  sleep 8
done
echo "DONE" >> "$OUT/run.log"
