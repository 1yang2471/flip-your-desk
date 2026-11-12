# Changelog

All notable changes to this project are documented here.

## 0.1.0

First public release.

- Reads the real desktop icon layout (position, name, icon pixels) through Explorer's desktop ListView
- Turns every icon position into a face-down card back that adapts to the wallpaper brightness
- Draws icons at random, drag to place or swap them, including onto slots that are still face down
- Timer and move counter, accuracy-only result screen (no hints about which icons were wrong)
- Save the new arrangement to the real desktop or restore the original, with a backup and a read-back check before every write
- Multi-monitor: one overlay window per display
- Chinese and English interface, keyboard playable, reduced-motion aware
