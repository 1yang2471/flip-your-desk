# Changelog

All notable changes to this project are documented here.

## Unreleased

- Added a study phase before each round: the real layout is shown for 3–6 seconds with a shrinking gold ring and seconds above the HUD (click it to skip), then the cards flip down. The timer and the timed challenge start exactly when the table is face down (`game::FLIP_MS`), and the study phase never counts toward the score. Late-loading windows skip the preview instead of replaying it.
- Fixed the timed-challenge clock: all monitors now share the backend `startedAtMs` anchor, and a replay resets the countdown instead of starting already expired.
- Fixed an armed drag that ended on its original slot or empty space still firing a click, which could select a card or silently swap two cards.
- Fixed drag listener cleanup (`pointercancel` was unbound with the wrong handler), exit-failure cards staying flipped away, and selection surviving into the result screen.
- Fixed the launcher mute preference only persisting once a round started, and a failed environment probe still showing "Ready" with an enabled Start button.
- Fixed HUD drift after deselecting a card, 44px hit areas overlapping adjacent header/HUD buttons, and result text actions sitting off-center.
- Enforced the 12px type floor, raised the how-to step numbers to a passing contrast, and removed the always-on `will-change` from every card.
- Save path: duplicate-name items are verified by their resolved item index instead of "any icon with this name landed"; a missing/renamed icon or an off-screen target now aborts the whole write before anything moves.
- Save path: the blocked `writing` flag is released on worker panic/cancel, and restore/quit share the same check-and-set lock so two monitors cannot write concurrently.
- Crash recovery: the icons-hidden marker is written before capture and cleared only after a successful restore; startup/probe/exit all retry a failed restore instead of forgetting it.
- Desktop reads now reject failed `LVM_GETITEMPOSITION` results and item-count changes during a scan.
- Capture progress is emitted as each parallel chunk finishes instead of only at 100%; label rectangles use the pre-filter listview index.
- Removed the unused JPEG decoder from the `image` dependency and aligned CI clippy with the local `--all-targets` gate.
- Added regression tests for the study countdown, timed clock, drag/click suppression, pointercancel unbinding, save-path helpers, type floor, version consistency, issue i18n parity, and the new UI spacing/contrast rules.

## 0.3.0

- **Desktop presence layer (purely visual, no backend changes).**
  - Idle breathing: after 8 seconds without input the card backs give a single 1px bob
  - Exit ritual: quitting from the confirmation dialog or restoring the original layout plays a card-by-card domino and only runs the real command once it finishes; the animation is cancellable via Esc or the visible "keep playing" button
  - Saving a new layout keeps the same "animate, then run the real command" ordering (the fake icon slide was dropped: it had no effect under the real CSS)
- Removed the focus-away doze after manual testing. Overlay windows are deliberately non-focusable (so clicking a card cannot raise them above normal windows), which made "come back and it restores" unreliable: the cards flipped back and needed a click to return. Breathing and the exit ritual are unaffected.
- Fixed breathing/domino animations losing to the inline deal-in animation
- Selected cards are now cancelled by clicking them again; Esc no longer clears the selection (the non-focusable overlay made the keyboard path unreliable). Esc still opens the exit confirmation when nothing is selected, closes it, and cancels the exit animation. Selecting a card keeps DOM focus so those actions can reach the overlay, and cards draw no focus ring, so selection shows a single gold ring.
- Fixed the exit ritual doing nothing on the result screen: every slot is face-up there and only card backs were animated. Face-up cards now flip away too, via an independent `rotate` transition that leaves the entrance animation intact, so cancelling reverses smoothly. The stagger also reserves the 320 ms flip so the last card finishes within the 1 s.
- Fixed the launcher: switching language no longer flashes the whole window transparent, the language button no longer stacks "中文" vertically, and the status panel no longer shows a needless scrollbar
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
