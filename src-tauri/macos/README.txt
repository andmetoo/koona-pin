Koona Pin for macOS
===================

Koona Pin is a desktop bookmark library: save the page you are on from your browser,
and the link stays on your computer.

Requirements: a Mac with Apple Silicon (M1 or later) and macOS 15 or later.


Install
-------

From the disk image: drag "Koona Pin" onto the "Applications" folder.
From the ZIP: move "Koona Pin.app" into your Applications folder.


The first start
---------------

This build is not yet signed with an Apple Developer ID, so macOS blocks the first
start and says it cannot check the app. Open it in one of these two ways.

A. System Settings (macOS 15)
   1. Open Koona Pin once from Applications. macOS refuses; click "Done".
   2. Open System Settings > Privacy & Security and scroll down to Security.
   3. Next to the message about Koona Pin, click "Open Anyway" and confirm with
      your password or Touch ID.
   After that, Koona Pin opens normally.

B. Terminal
   Run this command:

       xattr -dr com.apple.quarantine "/Applications/Koona Pin.app"

   It removes the "downloaded from the internet" mark (the quarantine) from
   Koona Pin only. Gatekeeper stays on and keeps checking every other app.
   Then open Koona Pin from Applications.


Updates
-------

Koona Pin does not update itself on macOS yet. To update, download the new version from
https://koona.app/pin/downloads/ and install it over the old one the same way. Your
library is kept.


More: https://koona.app/pin
