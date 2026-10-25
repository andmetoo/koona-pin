// Finder's thumbnail of a `.kpin` list (2.18.1): the document icon (kpin.icns). The list's type
// conforms to plain text so that Quick Look shows it as UTF-8, and Finder would then draw the text
// itself as the thumbnail in icon and list view. A thumbnail extension for the type wins over that.
// AppKit and QuickLookThumbnailing only: scripts/build-macos.mjs compiles it with swiftc, no Xcode project.
import AppKit
import ImageIO
import QuickLookThumbnailing

@objc(KoonaPinThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
    /// The largest image of the icon in this extension's Resources, read once. A CGImage is
    /// immutable, so Quick Look's requests, which come on several threads at once, may all draw it;
    /// an NSImage caches its representations and is not safe to draw so.
    private static let icon: CGImage? = {
        guard let url = Bundle.main.url(forResource: "kpin", withExtension: "icns"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let width = { (index: Int) -> Int in
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            return properties?[kCGImagePropertyPixelWidth] as? Int ?? 0
        }
        guard let largest = (0..<CGImageSourceGetCount(source)).max(by: { width($0) < width($1) }) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, largest, nil)
    }()

    override func provideThumbnail(for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
        guard let icon = Self.icon else {
            // No reply: Finder falls back to the type's icon.
            handler(nil, nil)
            return
        }
        let side = min(request.maximumSize.width, request.maximumSize.height)
        handler(QLThumbnailReply(contextSize: CGSize(width: side, height: side)) { (context: CGContext) -> Bool in
            context.interpolationQuality = .high
            context.draw(icon, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }, nil)
    }
}
