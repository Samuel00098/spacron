import DownloadGate from './DownloadGate';
import { licensingMode } from '@/lib/license';

// Read the licensing env at request time, so switching Lemon Squeezy on is a
// settings change rather than something baked into a static page.
export const dynamic = 'force-dynamic';

export default function DownloadPage() {
  const checkoutUrl = process.env.SPACRON_CHECKOUT_URL || '';
  return <DownloadGate checkoutUrl={checkoutUrl} mode={licensingMode()} />;
}
