#!/bin/bash
cd /Users/Admin/myterminal
for repo in duckdegen/apebot CyberPunkMetalHead/new-listings-trading-bot d1-dblaze/CEX-snipers yamato79/kucoin-sniper; do
  slug=$(echo "$repo" | tr '/' '__')
  found=""
  for name in README.rst readme.md Readme.md README.MD README.markdown docs/README.md readme.MD; do
    code=$(curl -s -m 15 -w "%{http_code}" -o "gh_search/readmes/${slug}.md" "https://raw.githubusercontent.com/${repo}/HEAD/${name}")
    if [ "$code" = "200" ]; then echo "$repo -> $name OK $(wc -c < gh_search/readmes/${slug}.md)"; found=1; break; fi
  done
  if [ -z "$found" ]; then echo "$repo -> STILL NONE"; rm -f "gh_search/readmes/${slug}.md"; fi
done
echo DONE2
