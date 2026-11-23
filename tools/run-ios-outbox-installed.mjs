// MIT. Hosted CI only. Never run against a personal simulator or installed app.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Immutable stock 28706ace outbox model, all packed cells in ascending order.
export const expected = Array.from({ length: 64 }, (_, bits) => {
  const creation = !!(bits & 1), exists = !!(bits & 2), live = !!(bits & 4), connected = !!(bits & 8);
  if (creation) return exists ? 1 : connected && live ? 2 : 0;
  if (!exists) return live && ((bits >> 4) === 0 || (bits >> 4) === 3) ? 1 : 0;
  return connected ? 2 : 0;
});
export function validate(result, mode, nonce) {
  assert.equal(result.nonce, nonce, 'stale receipt');
  assert.equal(result.mode, mode);
  if (mode === 'absent' || mode === 'blocked') {
    assert.equal(result.status, 'refused');
    assert.equal(result.faultInjection, true);
    assert.equal(result.outcomes, undefined);
  } else {
    assert.equal(result.status, 'passed', result.error);
    assert.deepEqual(result.outcomes, expected, 'all 64 native cells must match stock');
    assert.equal(result.storage, { seed: 'durable', reopen: 'reopened-and-removed', empty: 'empty-after-reopen' }[mode]);
  }
}
const delay = ms => new Promise(done => setTimeout(done, ms));
function command(program, args, timeout = 60_000) {
  return execFileSync(program, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }).trim();
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function main() {
  const [archiveArg, receiptsArg, commit, tree, outputArg, admission] = process.argv.slice(2);
  assert.equal(admission, '--admit-disposable-simulator');
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64', 'Intel linkage evidence cannot qualify arm64 execution');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.DEVELOPER_DIR, '/Applications/Xcode_26.4.1.app/Contents/Developer');
  assert.equal(command('xcodebuild', ['-version']), 'Xcode 26.4.1\nBuild version 17E202');
  assert.match(commit ?? '', /^[0-9a-f]{40}$/); assert.match(tree ?? '', /^[0-9a-f]{40}$/);
  assert.ok(archiveArg && receiptsArg && outputArg);
  const archive = resolve(archiveArg), receipts = resolve(receiptsArg), output = resolve(outputArg);
  mkdirSync(output, { recursive: true });
  assert.equal(readFileSync(join(receipts, 'source.txt'), 'utf8').trim(), `${commit} ${tree}`);
  assert.equal(readFileSync(join(receipts, 'fixture-entry.txt'), 'utf8').trim(), 'apps/mobile/proof/outbox-installed.tsx');
  const manifest = readFileSync(join(receipts, 'archive.sha256'), 'utf8').trim();
  assert.match(manifest, /^[0-9a-f]{64}  ios-outbox-simulator\.tar\.gz$/);
  assert.equal(hash(archive), manifest.slice(0, 64));
  const runtime = JSON.parse(command('xcrun', ['simctl', 'list', 'runtimes', '-j'])).runtimes
    .find(item => item.isAvailable && item.identifier === 'com.apple.CoreSimulator.SimRuntime.iOS-26-4');
  assert.ok(runtime, 'preinstalled iOS 26.4 runtime absent; downloads are forbidden');
  const scratch = join(output, `staging-${randomUUID()}`);
  mkdirSync(scratch);
  let udid;
  let cleanupError;
  try {
    const members = command('tar', ['-tzf', archive]).split('\n');
    assert.ok(members.length < 100_000);
    for (const member of members) assert.ok(!member.startsWith('/') && !member.split('/').includes('..'));
    command('tar', ['-xzf', archive, '-C', scratch]);
    const apps = readdirSync(scratch).filter(name => name.endsWith('.app'));
    assert.equal(apps.length, 1);
    const app = join(scratch, apps[0]);
    const plist = key => command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Info.plist')]);
    const executable = plist('CFBundleExecutable');
    assert.equal(basename(executable), executable);
    const binary = join(app, executable), bundle = plist('CFBundleIdentifier');
    assert.equal(command('xcrun', ['lipo', '-archs', binary]), 'arm64');
    assert.match(command('xcrun', ['nm', '-gU', binary]), / _t3_outbox_delivery_v1(?:\n|$)/);
    assert.ok(existsSync(join(app, 'main.jsbundle')), 'fixture must be embedded, no Metro fallback');
    // Keep stable basenames in receipts; never publish hosted paths.
    const binaryReceipt = readFileSync(join(receipts, 'artifacts.sha256'), 'utf8').split('\n')
      .find(line => line.endsWith(`/${apps[0]}/${executable}`));
    assert.ok(binaryReceipt); assert.equal(hash(binary), binaryReceipt.slice(0, 64));
    writeFileSync(join(output, 'admission.json'), JSON.stringify({ commit, tree, archive: hash(archive), binary: hash(binary), runtime: runtime.identifier, xcode: '17E202', arch: 'arm64' }, null, 2));
    udid = command('xcrun', ['simctl', 'create', `t12-outbox-${randomUUID()}`, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', runtime.identifier]);
    assert.match(udid, /^[0-9A-F-]{36}$/i);
    command('xcrun', ['simctl', 'boot', udid]);
    command('xcrun', ['simctl', 'bootstatus', udid, '-b'], 180_000);
    command('xcrun', ['simctl', 'install', udid, app], 120_000);
    const container = command('xcrun', ['simctl', 'get_app_container', udid, bundle, 'data']);
    const documents = join(container, 'Documents');
    mkdirSync(documents, { recursive: true });
    for (const mode of ['absent', 'blocked', 'seed', 'reopen', 'empty']) {
      const nonce = randomUUID();
      const resultPath = join(documents, 'outbox-proof-result.json');
      rmSync(resultPath, { force: true });
      writeFileSync(join(documents, 'outbox-proof-control.json'), JSON.stringify({ mode, nonce }));
      command('xcrun', ['simctl', 'launch', udid, bundle]);
      const deadline = Date.now() + 90_000;
      let result;
      while (Date.now() < deadline) {
        if (existsSync(resultPath)) {
          try { result = JSON.parse(readFileSync(resultPath, 'utf8')); } catch { /* writer may still be finishing */ }
          if (result) break;
        }
        await delay(250);
      }
      assert.ok(result, `fixture timed out: ${mode}`);
      writeFileSync(join(output, `${mode}.json`), JSON.stringify(result, null, 2));
      validate(result, mode, nonce);
      // No uninstall or data clear between launches; persisted production storage must survive.
      command('xcrun', ['simctl', 'terminate', udid, bundle]);
    }
  } finally {
    if (udid) {
      try { command('xcrun', ['simctl', 'shutdown', udid]); } catch (error) { cleanupError = String(error); }
      try { command('xcrun', ['simctl', 'delete', udid]); cleanupError = undefined; } catch (error) { cleanupError = String(error); }
      writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ ownedSimulatorDeleted: !cleanupError, error: cleanupError }));
    }
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(cleanupError, undefined, 'owned simulator cleanup failed');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
