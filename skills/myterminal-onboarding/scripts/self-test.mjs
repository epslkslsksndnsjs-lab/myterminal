/**
 * self-test.mjs — self-diagnostic for a deployed skill copy.
 *
 * This file is the ONLY "test code" in the myterminal-onboarding skill. It is
 * deliberately kept separate from onboard.mjs (the production script) so the
 * self-test can be removed or changed WITHOUT ever touching onboard.mjs's logic.
 *
 * It imports the production module only at call time (dynamic import below), so
 * there is no load-time coupling and no circular static import.
 *
 * Invoked via:  node scripts/onboard.mjs --self-test   (onboard.mjs delegates here)
 *
 * Returns 0 if every expected export/flag is present, 1 otherwise. CI also calls
 * it (see .github/workflows/ci.yaml) so a stale copy committed to the repo is
 * caught. After ADR-0053 the provider concept and the shell-profile mechanism are
 * GONE — their absence is checked just as hard as the presence of the new API, so
 * an old pre-ADR-0053 copy fails loudly instead of silently misbehaving.
 */

export async function doSelfTest() {
  const onboard = await import('./onboard.mjs');

  const results = [];
  const ok = (label, cond) => results.push({ label, pass: !!cond });

  // ── New ADR-0053 API must be present ──────────────────────────────────────
  ok('export: probeEndpoint', typeof onboard.probeEndpoint === 'function');
  ok('export: recommendL3', typeof onboard.recommendL3 === 'function');
  ok('export: detectL3ModelPresent', typeof onboard.detectL3ModelPresent === 'function');
  ok('export: normalizeBaseUrl', typeof onboard.normalizeBaseUrl === 'function');
  ok('export: nearestExistingAncestor', typeof onboard.nearestExistingAncestor === 'function');
  ok('export: mergeSubagentConfig', typeof onboard.mergeSubagentConfig === 'function');
  ok('export: doWriteConfig', typeof onboard.doWriteConfig === 'function');
  ok('export: checkHealth', typeof onboard.checkHealth === 'function');
  ok('export: doHealthCheck', typeof onboard.doHealthCheck === 'function');
  ok('export: doProbe', typeof onboard.doProbe === 'function');
  ok('export: repairConfig', typeof onboard.repairConfig === 'function');
  ok('export: lookupInstallDir', typeof onboard.lookupInstallDir === 'function');
  ok('export: shouldRebuild', typeof onboard.shouldRebuild === 'function');
  ok('export: detect', typeof onboard.detect === 'function');
  ok('export: SUBAGENT_OPTIONAL_FIELDS',
    Array.isArray(onboard.SUBAGENT_OPTIONAL_FIELDS) && onboard.SUBAGENT_OPTIONAL_FIELDS.length === 6);
  // ADR-0048 数值口径（同步源：src/config.ts applySubagentDefaults——maxTurns 700 / timeoutSec 7200）
  ok('optional fields match app defaults (applySubagentDefaults)',
    ['maxTurns=700', 'timeoutSec=7200', 'maxParallel=2', 'contextWindow=120000', 'maxOutput=32000', 'compactThreshold=80000']
      .every((spec) => {
        const [field, value] = spec.split('=');
        const entry = onboard.SUBAGENT_OPTIONAL_FIELDS.find((f) => f.field === field);
        return entry && entry.default === Number(value);
      }));
  ok('L3 thresholds fixed (2GB / 8GB)', onboard.L3_RECOMMEND_THRESHOLDS &&
    onboard.L3_RECOMMEND_THRESHOLDS.minFreeDiskBytes === 2 * 1024 ** 3 &&
    onboard.L3_RECOMMEND_THRESHOLDS.minTotalMemoryBytes === 8 * 1024 ** 3);

  // ── Pre-ADR-0053 API must be GONE (provider family + shell-profile machinery) ──
  const gone = [
    'SUPPORTED_PROVIDERS',
    'validateProvider',
    'MODEL_PREFIXES',
    'PROVIDER_MODEL_KEYWORDS',
    'VERIFY_ENDPOINTS',
    'verifyProviderKey',
    'detectShellProfile',
    'buildExportLine',
    'buildBaseUrlLine',
    'BASE_URL_ENV',
    'appendProfileBlock',
    'doKey',
  ];
  for (const name of gone) {
    ok(`export: ${name} gone (ADR-0053 removed it)`, onboard[name] === undefined);
  }

  const HELP = onboard.HELP || '';
  // ── Flags the new CLI must offer ──────────────────────────────────────────
  ok('flag: --write-config in HELP', HELP.includes('--write-config'));
  ok('flag: --base-url in HELP', HELP.includes('--base-url'));
  ok('flag: --model in HELP', HELP.includes('--model'));
  ok('flag: --fallback-model in HELP', HELP.includes('--fallback-model'));
  ok('flag: --probe in HELP', HELP.includes('--probe'));
  ok('flag: --healthcheck in HELP', HELP.includes('--healthcheck'));
  ok('flag: --repair in HELP', HELP.includes('--repair'));
  ok('flag: --self-test in HELP', HELP.includes('--self-test'));
  ok('flag: --key - (stdin) in HELP', HELP.includes('--key -'));
  // ── Legacy flags must be GONE ─────────────────────────────────────────────
  ok('flag: --provider gone from HELP', !HELP.includes('--provider'));
  ok('flag: --verify gone from HELP', !HELP.includes('--verify'));
  ok('flag: --test-call gone from HELP', !HELP.includes('--test-call'));
  ok('flag: --write-profile gone from HELP', !HELP.includes('--write-profile'));
  ok('flag: --base-url-as-provider-override gone', !HELP.includes('DASHSCOPE_BASE_URL'));

  const failed = results.filter((r) => !r.pass);
  for (const r of results) process.stdout.write(`${r.pass ? '✓' : '✗'} ${r.label}\n`);
  if (failed.length) {
    process.stdout.write(`\nSELF-TEST FAILED: ${failed.length} check(s) failed. This skill copy is stale or corrupted — re-sync from the MyTerminal repo.\n`);
    return 1;
  }
  process.stdout.write(`\nSELF-TEST PASSED: ${results.length} checks OK. Skill copy is current.\n`);
  return 0;
}
