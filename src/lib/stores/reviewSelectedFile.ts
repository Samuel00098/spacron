/**
 * Which file path is selected in Code Review.
 *
 * Kept as a store rather than `ReviewPanel` state because it outlived the panel
 * that used to own it: the selection was made in a left-drawer sidebar and read
 * by the full panel. That sidebar is gone (both halves are `ReviewPanel` now),
 * but the store stays — the selection survives the panel unmounting when you
 * switch rooms, so coming back lands on the same diff.
 */
import { writable } from './storeCompat';

/** Absolute-relative path of the file whose diff is shown in the main panel. */
export const reviewSelectedFile = writable<string | null>(null);
