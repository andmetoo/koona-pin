// Prints "<windowID> <x> <y> <w> <h>" of the on-screen windows of a process, one per line, for
// screencapture -l (scripts/site-screenshots-macos.mjs): swift window.swift <pid>. Any layer: the
// shots keep the window above others (floating); the script takes the largest.
import CoreGraphics
import Foundation

let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
  let b = w[kCGWindowBounds as String] as! [String: Any]
  print(w[kCGWindowNumber as String]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!)
}
