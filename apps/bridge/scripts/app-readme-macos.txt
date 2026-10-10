LG Dev Manager bridge
=====================

Double-click "lg-dev-manager-bridge" to start it. A Terminal window opens with the pairing token, and
https://lg.scoty.uk opens in your browser: paste the token on the Bridge page. Keep the Terminal window
open while you use the app; close it to stop the bridge.

You can run it straight from this disk image, or drag it to any folder first (Applications, Desktop...).

The first time
--------------
The app isn't notarized by Apple, so macOS refuses to open it the first time ("Apple could not verify...").
Click Done, then open System Settings > Privacy & Security, scroll down and click "Open Anyway" next to
lg-dev-manager-bridge, and confirm. macOS remembers the choice.

Or, in Terminal (after copying it to Applications):
    xattr -d com.apple.quarantine /Applications/lg-dev-manager-bridge

When the bridge first looks for your TV, macOS asks whether Terminal may find devices on your local
network: choose Allow.

Options: run it from Terminal with --help. Licenses: --license.
Not affiliated with or endorsed by LG Electronics. https://github.com/Scoty/lg-dev-manager
