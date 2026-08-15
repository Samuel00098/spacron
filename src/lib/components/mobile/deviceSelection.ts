/**
 * Which device the Android tab should have selected after a device scan.
 *
 * This runs every couple of seconds while nothing is streaming (see
 * `DEVICE_POLL_MS` in `MobilePanel.tsx`), so it is the rule that decides
 * whether an emulator booting in the background gets picked up on its own — and
 * equally, whether the user's current pick gets yanked out from under them. The
 * two failure modes pull in opposite directions, hence a real function with
 * real tests rather than an inline expression.
 */

/** The fields of an `android_list_devices` entry this decision needs. */
export interface ScannedDevice {
  serial: string;
  /** adb's device state: `device` is online; `offline`/`unauthorized` are not. */
  state: string;
}

/** adb's only state that means "ready to stream and take input". */
const ONLINE = 'device';

/**
 * Pick the serial to select, given the previous pick and the current scan.
 *
 * The order of preference is deliberate:
 *
 * 1. **Keep a working pick.** If the current selection is online it always
 *    wins, even when other devices are online too — re-pointing the panel at a
 *    different phone because it happened to appear is never what was wanted.
 * 2. **Adopt any online device.** Covers both "nothing selected yet" and "the
 *    selection died" — this is what makes a freshly booted emulator light up
 *    without a manual Refresh.
 * 3. **Hold a listed-but-not-ready pick.** An emulator mid-boot is listed as
 *    `offline` for a while; dropping it would make the picker flicker to empty
 *    and back for every boot.
 * 4. **Otherwise clear.** A serial that is no longer listed at all is gone
 *    (emulator shut down, cable pulled), and keeping it would leave the panel
 *    polling a device that cannot answer while showing its name as current.
 */
export function nextSelectedSerial(prev: string, devices: ScannedDevice[]): string {
  if (prev && devices.some((d) => d.serial === prev && d.state === ONLINE)) return prev;
  const online = devices.find((d) => d.state === ONLINE);
  if (online) return online.serial;
  if (prev && devices.some((d) => d.serial === prev)) return prev;
  return '';
}
