import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { assertRuntimeVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { profilePath, vaultPath } from './sandbox.mjs';

const evidence = new WeakMap();
export const nativeMenuEvidence = page => evidence.get(page) ?? [];
async function owner(page, focus = false) {
  await assertNoSafetyHold('interact with native QA menu'); await assertRuntimeVault(page);
  return page.evaluate(({ profilePath, vaultPath, focus }) => {
    const remote = window.electron?.remote;
    if (window.app.vault.adapter.getBasePath() !== vaultPath || remote?.app.getPath('userData') !== profilePath) throw new Error('Native menu profile/vault mismatch');
    const win = remote.getCurrentWindow(); if (focus) win.focus();
    return { pid: remote.process.pid, profilePath, vaultPath, windowTitle: win.getTitle() };
  }, { profilePath, vaultPath, focus });
}
export async function focusNativeWindow(page) { if (process.platform === 'darwin') await owner(page, true); }

// Real macOS AXPress on the actual popup, not a Reader/controller callback.
// Exclude menu bars and web content, and require exactly one matching item in
// the verified process. PID handles avoid ambiguous duplicate "Obsidian" names.
const ax = `import Foundation; import ApplicationServices
let args=Array(CommandLine.arguments.suffix(3)); let pid=pid_t(args[0])!; let mode=args[1]; let wanted=args[2]
func attr(_ e:AXUIElement,_ n:CFString)->CFTypeRef?{var v:CFTypeRef?;return AXUIElementCopyAttributeValue(e,n,&v) == .success ? v:nil}
var count=0;var titles:[String]=[];var matches:[AXUIElement]=[]
func walk(_ e:AXUIElement,_ d:Int){count+=1;let role=attr(e,kAXRoleAttribute as CFString) as? String ?? "";if role == "AXMenuBar" || role == "AXWebArea" {return};if role == "AXMenuItem" {let title=attr(e,kAXTitleAttribute as CFString) as? String ?? "";titles.append(title);if title == wanted{matches.append(e)}};if d<24 && count<6000{for child in attr(e,kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []{walk(child,d+1)}}}
guard AXIsProcessTrusted() else{fputs("Accessibility access unavailable\\n",stderr);exit(2)}
walk(AXUIElementCreateApplication(pid),0);var pressed=false
if mode == "press" {guard matches.count == 1 else{fputs("Expected exactly one native popup item\\n",stderr);exit(3)};var actual:pid_t=0;AXUIElementGetPid(matches[0],&actual);guard actual == pid else{exit(4)};guard AXUIElementPerformAction(matches[0],kAXPressAction as CFString) == .success else{exit(5)};pressed=true}
let data=try! JSONSerialization.data(withJSONObject:["pid":Int(pid),"titles":titles,"pressed":pressed,"nodes":count],options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)`;
function inspect(context, mode, title = '') {
  assert.ok(Number.isInteger(context.pid) && context.pid > 1);
  const run = spawnSync('swift', ['-e', ax, String(context.pid), mode, title], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr || 'Native accessibility menu operation failed');
  const result = JSON.parse(run.stdout); assert.equal(result.pid, context.pid); return result;
}
export async function waitNativeMenu(page, menu, title) {
  if (await menu.isVisible()) return;
  assert.equal(process.platform, 'darwin', 'Expected a visible Obsidian DOM menu');
  const context = await owner(page);
  await expect.poll(() => inspect(context, 'list').titles.includes(title), { timeout: 10_000 }).toBe(true);
}
export async function pressNativeMenu(page, menu, title) {
  await waitNativeMenu(page, menu, title);
  let proof;
  if (await menu.isVisible()) {
    await assertRuntimeVault(page); const item = menu.getByText(title, { exact: true }); await expect(item).toHaveCount(1); await item.click();
    proof = { title, delivery: 'Native Obsidian DOM Menu click' };
  } else {
    const context = await owner(page); proof = { ...context, ...inspect(context, 'press', title), title, delivery: 'Real macOS accessibility AXPress on native popup item' };
    assert.equal(proof.pressed, true);
  }
  evidence.set(page, [...nativeMenuEvidence(page), proof]); return proof;
}
