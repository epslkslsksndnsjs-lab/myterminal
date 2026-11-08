#!/bin/bash
cd /Users/Admin/myterminal/verify2 || exit 1
: > verify.log
while IFS= read -r repo; do
  [ -z "$repo" ] && continue
  fname=$(echo "$repo" | tr '/' '_')
  code=$(curl -s -o "${fname}.json" -w "%{http_code}" \
     -H "User-Agent: myterminal-research" \
     -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/${repo}")
  echo "${repo} http=${code}" >> verify.log
  echo "${repo} http=${code}"
  sleep 1.2
done < repos.txt
echo "ALLDONE" >> verify.log
echo "ALLDONE"
