import json, glob, os, re

SRC = "/Users/Admin/myterminal/.myterminal/workflows/runs/wf_71a518c957daaf7c/agents"
OUT = "/Users/Admin/myterminal/fx_sweep/lanes"
os.makedirs(OUT, exist_ok=True)

files = sorted(glob.glob(os.path.join(SRC, "d00*.json")))
print("=== LANE FILE INDEX ===")
for f in files:
    d = json.load(open(f))
    res = d.get("result") or ""
    name = os.path.basename(f)[:-5]
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", d.get("label", name))
    with open(os.path.join(OUT, f"{name}_{safe}.txt"), "w") as w:
        w.write(res)
    # detect network-block markers
    blocked = bool(re.search(r"network-block|network block|read-only|refused|allowlist", res, re.I))
    print(f"{name} | label={d.get('label')} | status={d.get('status')} | tokens={d.get('outputTokens')} | chars={len(res)} | blocked_marker={blocked}")
