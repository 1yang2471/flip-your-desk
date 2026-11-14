# Changelog

All notable changes to this project are documented here.

## 0.3.0

- **Desktop presence layer (purely visual, no backend changes).**
  - Focus-away doze: switch away from the window and every flipped-open face turns back down while the HUD collapses to a small gold dot; returning restores them exactly, with no change to game state or progress
  - Idle breathing: after 8 seconds without input the card backs give a single 1px bob
  - Exit ritual: quitting (Esc confirm) or restoring the original layout plays a card-by-card domino and only runs the real command once it finishes; the animation is cancellable via Esc or the visible "keep playing" button
  - Saving a new layout keeps the same "animate, then run the real command" ordering (the fake icon slide was dropped: it had no effect under the real CSS)
- Fixed the desktop-presence CSS so breathing/domino actually play (they were losing to the inline deal-in animation); the doze veil now hides the face content and repaints a card back on the card instead of flipping it (a rotateY flip left mirrored icon/text visible, because the face inner uses `transform-style: preserve-3d`)
- Fixed the launcher header: the language button no longer stacks "中文" vertically and the tagline stays on one line, so the status panel no longer shows a needless scrollbar
- Frontend regression tests now assert real computed styles and real module behavior instead of source-string matches; `npm test` builds first, and CI/release run it

## 0.2.0

- **Timed challenge mode**: pick it from the launcher; the limit scales with icon count (30s + 5s per icon), the HUD counts down and turns gold in the last 20%, and the round settles automatically when time runs out (marked "out of time")
- **Fixed: saving a new layout now actually works.** The desktop write used the wrong Win32 message constant (`LVM_SETITEMPOSITION32` was `0x1049`, a GET message, instead of `0x1031`), so every save silently did nothing while reporting success. Verified end-to-end on real hardware.
- Fixed duplicated-name icons being moved twice while another icon stayed put (now disambiguated by original position)
- Fixed icon-label reads after the hide/show toggle returning stale or empty text
- Fixed a race where two monitors saving at once could both write to the desktop
- Layout backup now written atomically (temp file + rename) so a mid-save kill can't corrupt it
- CI: fixed long-standing `fmt`/`clippy -D warnings` failures, and the release workflow now runs the same gates before building

## 0.1.1

- Parallelized start-up capture (serialized collection + parallel cropping) with progress events to the launcher window
- Read-only detection of desktop organizer tools (e.g. Fences) with a non-blocking hint
- Docs synced with reality: mouse-only play, real installer asset names in both READMEs

## 0.1.0

First public release.

- Reads the real desktop icon layout (position, name, icon pixels) through Explorer's desktop ListView
- Turns every icon position into a face-down card back that adapts to the wallpaper brightness
- Draws icons at random, drag to place or swap them, including onto slots that are still face down
- Timer and move counter, accuracy-only result screen (no hints about which icons were wrong)
- Save the new arrangement to the real desktop or restore the original, with a backup and a read-back check before every write
- Multi-monitor: one overlay window per display
- Chinese and English interface, mouse-only play, reduced-motion aware
