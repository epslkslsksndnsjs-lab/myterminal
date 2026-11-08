#!/bin/bash
cd /Users/Admin/myterminal
mkdir -p gh_search/readmes
while IFS= read -r repo; do
  [ -z "$repo" ] && continue
  slug=$(echo "$repo" | tr '/' '__')
  code=000
  for br in HEAD main master; do
    code=$(curl -s -m 20 -w "%{http_code}" -o "gh_search/readmes/${slug}.md" "https://raw.githubusercontent.com/${repo}/${br}/README.md")
    if [ "$code" = "200" ]; then echo "$repo -> $br OK $(wc -c < gh_search/readmes/${slug}.md)"; break; fi
  done
  if [ "$code" != "200" ]; then echo "$repo -> NONE ($code)"; rm -f "gh_search/readmes/${slug}.md"; fi
  sleep 1
done < candidates.txt
echo ALLDONE
