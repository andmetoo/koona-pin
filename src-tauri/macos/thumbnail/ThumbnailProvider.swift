// Finder's thumbnail of a `.kpin` list (2.18.1): the document icon (kpin.icns). The list's type
// conforms to plain text so that Quick Look shows it as UTF-8, and Finder would then draw the text
// itself as the thumbnail in icon and list view. A thumbnail extension for the type wins over that.
// AppKit and QuickLookThumbnailing only: scripts/build-macos.mjs compiles it with swiftc, no Xcode project.
import AppKit
import QuickLookThumbnailing

@objc(KoonaPinThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
    /// The icon in this extension's Resources, read once.
    private static let icon = Bundle.main.url(forResource: "kpin", withExtension: "icns").flatMap(NSImage.init(contentsOf:))

    override func provideThumbnail(for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
        guard let icon = Self.icon else {
            // No reply: Finder falls back to the type's icon.
            handler(nil, nil)
            return
        }
        let side = min(request.maximumSize.width, request.maximumSize.height)
        handler(QLThumbnailReply(contextSize: CGSize(width: side, height: side)) { () -> Bool in
            icon.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }, nil)
    }
}
