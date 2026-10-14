# The disk image of a macOS release for dmgbuild (scripts/build-macos.mjs, NP-051): the app and a link to
# Applications in an icon view of 660x400 over background.tiff, the volume with volume.icns. dmgbuild writes
# the window's .DS_Store itself, without Finder or AppleScript, so a CI runner gets the same window as a
# Mac. The background (scripts/dmg-assets.mjs) is drawn for these positions; change both together.
# build-macos.mjs passes -D app=<path of Koona Pin.app> and -D here=<this folder> (dmgbuild runs this file
# without __file__).
import os.path

here = defines["here"]
app = defines["app"]
name = os.path.basename(app)

format = "UDZO"
compression_level = 9
filesystem = "HFS+"

files = [app]
symlinks = {"Applications": "/Applications"}
hide_extension = [name]

icon = os.path.join(here, "volume.icns")
background = os.path.join(here, "background.tiff")

# The frame: 660x400 of content under a title bar of up to 32 points (macOS 26); background.tiff is 440 high.
window_rect = ((200, 160), (660, 432))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
include_icon_view_settings = True
include_list_view_settings = False

icon_size = 128
text_size = 13
arrange_by = None
icon_locations = {name: (180, 170), "Applications": (480, 170)}
