# The notification card: colour in the rail, never the surface

`AgentNotifications.css`, redesigned 2026-08-26 after the stack was reported as
looking like "mid-century gold".

## The bug that caused it

The completion card painted its status colour across the whole card:

```css
background: color-mix(in srgb, var(--cc) 7%, rgba(var(--bg-secondary-rgb), 1));
border:     1px solid color-mix(in srgb, var(--cc) 22%, var(--border));
```

`--cc` is `--warning` for a blocked card, and `--warning` is **`#a86008`** in
light mode — a deep ochre, chosen for contrast, not for washing over a panel.
Seven percent of it across the surface plus a 22% border is a gold film, and
because the light theme's surfaces are near-white it reads as dirty rather than
tinted. Dark mode hid it (`#fbbf24` at 7% over `#121216` is nearly invisible),
which is why it survived so long.

**The rule now: a status colour may light up a 3px rail, an icon, and a chip —
never a surface or a full border.** That keeps three cards in one stack looking
like one component in three states rather than three differently-coloured
things, and it holds at any token value, which a tint does not.

## The rest of the pass

- **Type scale.** It was 11 / 10.5 / 10 / 10.5px — four sizes inside one pixel
  is not a hierarchy, it is just small. Now 13px name, 12px message, 11.5px
  task (muted), 10.5px time.
- **The message leads.** `.orc-comp-reason` (what the agent actually said) was
  the smallest, faintest line on the card. It is now the largest thing under
  the name. See `completionBody` in inbox.ts for the same principle in the row.
- **One border.** `.agent-notif`'s shadow carried `0 0 0 1px var(--border)`
  *and* every card drew its own border — a double outline. The ring is gone.
- **Rails are `::before`, not `border-left`.** A left border squares off the
  card's rounded corners; the pseudo-element with `overflow: hidden` does not.
  Both the completion card and the mailbox card use the same shell now.
- Action buttons sit side by side at 55% opacity until the card is hovered or
  one is focused. Stacked vertically they read as a scrollbar.

## Do not

- Re-add a surface tint "just a little" — 3% is the same bug at lower volume.
- Give the grouped card a different radius, padding or shadow from the single
  card. `.orc-completion-group` differs in exactly one property (`padding-right`,
  because it has one button rather than two).

Related: [[agent-report-status]], [[agent-inbox-unread]]
