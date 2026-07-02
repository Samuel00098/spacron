/**
 * Lightweight store that tracks which file path is currently selected in the
 * Code Review sidebar panel. The full ReviewPanel reads this to know which
 * file's diff to render.
 */
import { writable } from './storeCompat';

/** Absolute-relative path of the file whose diff is shown in the main panel. */
export const reviewSelectedFile = writable<string | null>(null);
