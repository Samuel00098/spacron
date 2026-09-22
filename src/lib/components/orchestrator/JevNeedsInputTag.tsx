import { useEffect, useState } from 'react';
import { NEEDS_INPUT_LABELS, triageNeedsInput, type NeedsInputCategory } from '$lib/services/jev';

/** Small optional category. The raw reason remains the primary evidence. */
export default function JevNeedsInputTag({ reason }: { reason: string }) {
  const [category, setCategory] = useState<NeedsInputCategory | null>(null);
  useEffect(() => {
    let live = true;
    setCategory(null);
    if (reason.trim()) void triageNeedsInput(reason).then((value) => { if (live) setCategory(value); });
    return () => { live = false; };
  }, [reason]);
  return category ? <span className="inbox-detail-fact" aria-label={`Needs input category: ${NEEDS_INPUT_LABELS[category]}`}>{NEEDS_INPUT_LABELS[category]}</span> : null;
}
