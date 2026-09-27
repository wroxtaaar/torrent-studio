# Seedr Browser Stream Test

This branch is an isolated experiment for one question:

> Can a direct Seedr video URL that plays in VLC/MX Player also play natively in Chrome/Firefox on desktop and Android?

Open the Vite app at `/seedr-test.html`, paste the same direct Seedr video URL used by VLC/MX Player, and press **Play in browser**.

The test intentionally does **not** use Torrent Studio's torrent, qBittorrent, or Seedr API logic.

## Test order

1. Test the same URL on desktop Chrome/Firefox.
2. Test it on Android Chrome.
3. Try seeking forward/backward.
4. If native playback fails, capture the browser error and inspect the Seedr response headers.
5. Only after the direct URL behavior is understood, add a minimal Range-aware proxy on this branch.
6. Integrate the proven implementation into the main application only after the standalone test works reliably.
