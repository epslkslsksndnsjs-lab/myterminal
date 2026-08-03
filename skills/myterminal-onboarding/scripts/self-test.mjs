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
 * caught. Provider-list parity with the main repo is enforced separately by
 * scripts/check-provider-sync.mjs — this copy has no repo to compare against.
 */

export async function doSelfTest() {
  const onboard = await import('./onboard.mjs');
  const { HELP, SUPPORTED_PROVIDERS } = onboard;

  const results = [];
  const ok = (label, cond) => results.push({ label, pass: !!cond });

  ok('export: verifyProviderKey', typeof onboard.verifyProviderKey === 'function');
  ok('export: checkHealth', typeof onboard.checkHealth === 'function');
  ok('export: doKey', typeof onboard.doKey === 'function');
  ok('export: doHealthCheck', typeof onboard.doHealthCheck === 'function');
  ok('export: doWriteConfig', typeof onboard.doWriteConfig === 'function');
  ok('export: repairConfig', typeof onboard.repairConfig === 'function');
  ok('export: buildBaseUrlLine', typeof onboard.buildBaseUrlLine === 'function');
  ok('export: validateModelForProvider', typeof onboard.validateModelForProvider === 'function');
  ok('export: lookupInstallDir', typeof onboard.lookupInstallDir === 'function');
  ok('export: shouldRebuild', typeof onboard.shouldRebuild === 'function');
  ok('export: detect', typeof onboard.detect === 'function');
  ok('export: SUPPORTED_PROVIDERS', Array.isArray(SUPPORTED_PROVIDERS) && SUPPORTED_PROVIDERS.length >= 5);
  ok('flag: --verify in HELP', HELP.includes('--verify'));
  ok('flag: --base-url in HELP', HELP.includes('--base-url'));
  ok('flag: --healthcheck in HELP', HELP.includes('--healthcheck'));
  ok('flag: --fallback-model in HELP', HELP.includes('--fallback-model'));
  ok('providers: openai/anthropic/deepseek/glm/qwen all present',
    ['openai', 'anthropic', 'deepseek', 'glm', 'qwen'].every((p) =>
      SUPPORTED_PROVIDERS.some((x) => x.provider === p)));

  const failed = results.filter((r) => !r.pass);
  for (const r of results) process.stdout.write(`${r.pass ? '✓' : '✗'} ${r.label}\n`);
  if (failed.length) {
    process.stdout.write(`\nSELF-TEST FAILED: ${failed.length} check(s) failed. This skill copy is stale or corrupted — re-sync from the MyTerminal repo.\n`);
    return 1;
  }
  process.stdout.write(`\nSELF-TEST PASSED: ${results.length} checks OK. Skill copy is current.\n`);
  return 0;
}
