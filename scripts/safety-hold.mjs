import { join } from 'node:path';
import {
  defaultVaultPath,
  regularFile,
  repository,
  sandboxPath,
  statOrNull,
  vaultPath,
} from './sandbox.mjs';

// Keep the existing sentinel: renaming the product never releases a safety hold.
export const safetyHoldPath = join(sandboxPath, 'reader2-safety-hold.json');
export async function readSafetyHold() {
  if (!(await statOrNull(safetyHoldPath))) return null;
  try {
    const hold = JSON.parse(await regularFile(safetyHoldPath));
    if (
      hold.schemaVersion !== 1 ||
      hold.repository !== repository ||
      hold.vaultPath !== defaultVaultPath ||
      hold.state !== 'held'
    )
      throw new Error('Invalid hold identity/state');
    return hold;
  } catch (cause) {
    const error = new Error(
      `READER SAFETY HOLD is unreadable/invalid; fail closed: ${safetyHoldPath}`,
      { cause },
    );
    error.code = 'READER_SAFETY_HOLD';
    throw error;
  }
}

// There is intentionally no force flag, automatic expiry, or release function.
// Every old/queued open/reload request is cancelled. Only MAIN's new explicit
// release naming a verified replacement artifact hash can authorize removal.
export async function assertNoSafetyHold(operation) {
  if (vaultPath !== defaultVaultPath) return; // Separately authorized, fixed acceptance vault only.
  await assertDefaultVaultNotHeld(operation);
}
export async function assertDefaultVaultNotHeld(operation) {
  const hold = await readSafetyHold();
  if (!hold) return;
  const error = new Error(
    `READER SAFETY HOLD blocks ${operation}. Old queued requests/finally restoration are NOT authorization. Explicit MAIN release with a verified replacement SHA-256 required. ${safetyHoldPath}`,
  );
  error.code = 'READER_SAFETY_HOLD';
  throw error;
}
