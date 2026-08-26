# The preview room stays mounted (like the terminals)

`preview` is in `isPersistentRoomId` and in `persistentStageRooms`
(`AppShell.tsx`), alongside `terminal`, `dev-terminal` and the agent rooms. Those
rooms are rendered for as long as they are in `openRooms` and hidden with the
`.stage-hidden` class (`visibility: hidden` + `clip-path`) rather than unmounted.

For the terminals that exists to protect the xterm's fit. For the preview it
protects the **iframes**: unmounting destroyed the loaded page, so every trip to
another room and back reloaded whatever the user was looking at — losing scroll,
form state and video position, and re-hitting the dev server. Scroll and media
position are restored over the postMessage bridge, but that is a repair, not a
substitute for not tearing the page down.

If you add a room whose body holds live web content or a long-lived connection,
put it in both places or it will silently remount on every focus switch.

Related: [[preview-iframe-bridge]], [[split-maximize-zoom-layout]]
