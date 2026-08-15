import { describe, expect, it } from 'vitest';

import { nextSelectedSerial, type ScannedDevice } from './deviceSelection';

const online = (serial: string): ScannedDevice => ({ serial, state: 'device' });
const offline = (serial: string): ScannedDevice => ({ serial, state: 'offline' });

describe('nextSelectedSerial', () => {
  it('adopts a device that appears while nothing is selected', () => {
    // The whole reason the scan exists: an emulator booted outside the panel
    // must light it up without a manual Refresh.
    expect(nextSelectedSerial('', [online('emulator-5554')])).toBe('emulator-5554');
  });

  it('keeps a working pick even when others are online', () => {
    // Re-pointing the panel at a different phone because it happened to show
    // up would move the user's taps to the wrong device mid-session.
    expect(
      nextSelectedSerial('emulator-5554', [online('emulator-5554'), online('emulator-5556')]),
    ).toBe('emulator-5554');
  });

  it('moves on when the current pick goes offline and another is ready', () => {
    expect(
      nextSelectedSerial('emulator-5554', [offline('emulator-5554'), online('emulator-5556')]),
    ).toBe('emulator-5556');
  });

  it('holds a listed-but-booting pick rather than flickering to empty', () => {
    // An emulator is listed `offline` for a while as it boots. Dropping it
    // would empty the picker and refill it a second later, every boot.
    expect(nextSelectedSerial('emulator-5554', [offline('emulator-5554')])).toBe('emulator-5554');
  });

  it('clears a pick that has vanished from the list', () => {
    // The device is gone (emulator shut down, cable pulled). Holding it would
    // leave the panel naming a device it cannot reach and polling it forever.
    expect(nextSelectedSerial('emulator-5554', [])).toBe('');
    expect(nextSelectedSerial('emulator-5554', [offline('39affe1a')])).toBe('');
  });

  it('prefers an online device over holding a dead pick', () => {
    expect(nextSelectedSerial('emulator-5554', [online('39affe1a')])).toBe('39affe1a');
  });

  it('stays empty when there is nothing to pick', () => {
    expect(nextSelectedSerial('', [])).toBe('');
    expect(nextSelectedSerial('', [offline('emulator-5554')])).toBe('');
  });
});
