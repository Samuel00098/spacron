# Onboarding walkthrough removed

The first-run onboarding walkthrough was deleted on 2026-09-22 — the component
(`OnboardingWalkthrough.tsx`/`.css`), its mount in `App.tsx`, and all the
`onboardingCompleted` plumbing in `stores/settings.ts` and
`stores/zustand/settings.ts`. Nothing in the code reads the flag any more.

Leftovers that are now **dead but persisted**, so a future agent does not
mistake them for live state:

- `localStorage['spacron_onboardingCompleted']` (and the `forge_` mirror) still
  hold whatever value was written before removal — ignored.
- `config_dir/app_flags.json` may still hold an `onboardingCompleted` entry.
  The generic `app_flag_*` mechanism and `app-flags.ts` were **kept** as reusable
  durable-flag infra, but currently have **no callers** — safe to delete as a
  whole if it is still unused.