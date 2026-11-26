import Foundation
import AppKit
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

// Generates Apple-grade anti-aliased PNG icons for Agent Session Monitor and its agents,
// plus a full multi-resolution AppIcon.iconset directory ready for `iconutil`.

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1.0) -> CGColor {
    CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [r / 255.0, g / 255.0, b / 255.0, a])!
}

func squirclePath(in rect: CGRect, radius: CGFloat) -> CGPath {
    // Continuous-curvature rounded rect approximating macOS Big Sur+ squircle corners.
    let path = CGMutablePath()
    let minX = rect.minX, maxX = rect.maxX
    let minY = rect.minY, maxY = rect.maxY
    let r = min(radius, min(rect.width, rect.height) * 0.45)
    let k: CGFloat = r * 1.18 // smooth shoulder pull
    let c: CGFloat = r * 0.36 // corner bezier handle

    path.move(to: CGPoint(x: minX + k, y: minY))
    path.addLine(to: CGPoint(x: maxX - k, y: minY))
    path.addCurve(to: CGPoint(x: maxX, y: minY + k),
                  control1: CGPoint(x: maxX - c, y: minY),
                  control2: CGPoint(x: maxX, y: minY + c))
    path.addLine(to: CGPoint(x: maxX, y: maxY - k))
    path.addCurve(to: CGPoint(x: maxX - k, y: maxY),
                  control1: CGPoint(x: maxX, y: maxY - c),
                  control2: CGPoint(x: maxX - c, y: maxY))
    path.addLine(to: CGPoint(x: minX + k, y: maxY))
    path.addCurve(to: CGPoint(x: minX, y: maxY - k),
                  control1: CGPoint(x: minX + c, y: maxY),
                  control2: CGPoint(x: minX, y: maxY - c))
    path.addLine(to: CGPoint(x: minX, y: minY + k))
    path.addCurve(to: CGPoint(x: minX + k, y: minY),
                  control1: CGPoint(x: minX, y: minY + c),
                  control2: CGPoint(x: minX + c, y: minY))
    path.closeSubpath()
    return path
}

func makeContext(size: Int) -> CGContext {
    let cs = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high
    return ctx
}

func savePNG(_ ctx: CGContext, to url: URL) throws {
    guard let image = ctx.makeImage() else {
        throw NSError(domain: "IconGen", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create CGImage"])
    }
    let type = UTType.png.identifier as CFString
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type, 1, nil) else {
        throw NSError(domain: "IconGen", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to open \(url.path)"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) {
        throw NSError(domain: "IconGen", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to write \(url.path)"])
    }
}

func drawLinearGradient(_ ctx: CGContext, colors: [CGColor], locations: [CGFloat], start: CGPoint, end: CGPoint) {
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let grad = CGGradient(colorsSpace: cs, colors: colors as CFArray, locations: locations) else { return }
    ctx.drawLinearGradient(grad, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

func drawRadialGlow(_ ctx: CGContext, center: CGPoint, radius: CGFloat, inner: CGColor, outer: CGColor) {
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let grad = CGGradient(colorsSpace: cs, colors: [inner, outer] as CFArray, locations: [0, 1]) else { return }
    ctx.drawRadialGradient(grad, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
}

func drawRimHighlight(_ ctx: CGContext, path: CGPath, width: CGFloat, alpha: CGFloat = 0.18) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.addPath(path)
    ctx.setStrokeColor(color(255, 255, 255, alpha))
    ctx.setLineWidth(width)
    ctx.strokePath()
    ctx.restoreGState()
}

// MARK: - 1. App Icon (Agent Session Monitor — dark slate/cobalt squircle + 3-node activity glyph)

func drawAppIcon(size: Int, macOSGridInset: Bool) -> CGContext {
    let ctx = makeContext(size: size)
    let s = CGFloat(size)
    // macOS Big Sur+ app icon grid places an 824/1024 squircle centered with subtle drop shadow.
    let inset = macOSGridInset ? s * 0.095 : s * 0.02
    let card = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = card.width * 0.225
    let bgPath = squirclePath(in: card, radius: radius)

    if macOSGridInset {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.018), blur: s * 0.036, color: color(0, 0, 0, 0.42))
        ctx.addPath(bgPath)
        ctx.setFillColor(color(15, 23, 42, 1))
        ctx.fillPath()
        ctx.restoreGState()
    }

    ctx.saveGState()
    ctx.addPath(bgPath)
    ctx.clip()

    // Deep slate -> royal cobalt gradient (bottom to top in CG coordinates)
    drawLinearGradient(
        ctx,
        colors: [color(10, 15, 30), color(21, 34, 68), color(30, 58, 120)],
        locations: [0.0, 0.55, 1.0],
        start: CGPoint(x: card.midX, y: card.minY),
        end: CGPoint(x: card.midX, y: card.maxY)
    )

    // Soft Apple-style ambient radial glows
    drawRadialGlow(
        ctx,
        center: CGPoint(x: card.minX + card.width * 0.22, y: card.maxY - card.height * 0.16),
        radius: card.width * 0.72,
        inner: color(56, 189, 248, 0.24),
        outer: color(56, 189, 248, 0.0)
    )
    drawRadialGlow(
        ctx,
        center: CGPoint(x: card.maxX - card.width * 0.15, y: card.minY + card.height * 0.18),
        radius: card.width * 0.65,
        inner: color(129, 140, 248, 0.22),
        outer: color(129, 140, 248, 0.0)
    )

    // Subtle top glass sheen
    let sheenRect = CGRect(x: card.minX, y: card.midY, width: card.width, height: card.height * 0.5)
    drawLinearGradient(
        ctx,
        colors: [color(255, 255, 255, 0.0), color(255, 255, 255, 0.08)],
        locations: [0.0, 1.0],
        start: CGPoint(x: sheenRect.midX, y: sheenRect.minY),
        end: CGPoint(x: sheenRect.midX, y: sheenRect.maxY)
    )

    // 3-node session activity glyph matching media/sessions.svg (CG y goes bottom -> top)
    let w = card.width
    let dotX = card.minX + w * 0.235
    let barStartX = card.minX + w * 0.375
    let dotR = w * 0.068
    let barH = w * 0.105
    let rows: [(yFrac: CGFloat, barLen: CGFloat, dotTop: CGColor, dotBottom: CGColor, glow: CGColor, barAlpha: CGFloat)] = [
        // Top row: Attention / approval (warm amber-coral)
        (0.70, 0.445, color(253, 186, 116), color(249, 115, 22), color(251, 146, 60, 0.45), 0.96),
        // Middle row: Working / live (sky cyan)
        (0.50, 0.345, color(125, 211, 252), color(14, 165, 233), color(56, 189, 248, 0.45), 0.88),
        // Bottom row: Completed / ready (emerald mint)
        (0.30, 0.245, color(110, 231, 183), color(16, 185, 129), color(52, 211, 153, 0.40), 0.76),
    ]

    for row in rows {
        let cy = card.minY + card.height * row.yFrac

        // Soft halo under status dot
        drawRadialGlow(
            ctx,
            center: CGPoint(x: dotX, y: cy),
            radius: dotR * 2.35,
            inner: row.glow,
            outer: color(0, 0, 0, 0)
        )

        // Status node circle with subtle vertical gradient + depth shadow
        ctx.saveGState()
        let dotRect = CGRect(x: dotX - dotR, y: cy - dotR, width: dotR * 2, height: dotR * 2)
        ctx.setShadow(offset: CGSize(width: 0, height: -w * 0.012), blur: w * 0.025, color: color(0, 0, 0, 0.38))
        ctx.addEllipse(in: dotRect)
        ctx.setFillColor(row.dotBottom)
        ctx.fillPath()
        ctx.restoreGState()

        ctx.saveGState()
        ctx.addEllipse(in: dotRect)
        ctx.clip()
        drawLinearGradient(
            ctx,
            colors: [row.dotBottom, row.dotTop],
            locations: [0.0, 1.0],
            start: CGPoint(x: dotX, y: dotRect.minY),
            end: CGPoint(x: dotX, y: dotRect.maxY)
        )
        ctx.restoreGState()

        // Sleek pill bar
        let barRect = CGRect(x: barStartX, y: cy - barH / 2, width: w * row.barLen, height: barH)
        let barPath = CGPath(roundedRect: barRect, cornerWidth: barH / 2, cornerHeight: barH / 2, transform: nil)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -w * 0.012), blur: w * 0.024, color: color(0, 0, 0, 0.35))
        ctx.addPath(barPath)
        ctx.setFillColor(color(241, 245, 249, row.barAlpha))
        ctx.fillPath()
        ctx.restoreGState()
    }

    ctx.restoreGState()
    drawRimHighlight(ctx, path: bgPath, width: max(1.5, card.width * 0.014), alpha: 0.22)
    return ctx
}

// MARK: - Shared Apple-Grade Fallback Monogram Badge Renderer
//
// Bundled provider fallback icons are original, trademark-safe typographic monogram badges
// ("CL", "CX", "AG") in each agent's signature palette. They are displayed when a user does
// not have the vendor's official VS Code extension installed (e.g., CLI-only setups) or in
// public documentation. When official vendor extensions ARE installed, src/logos.cjs loads
// their genuine local assets dynamically at runtime without redistributing third-party marks.

struct BadgePalette {
    let monogram: String
    let gradientColors: [CGColor]
    let gradientLocations: [CGFloat]
    let gradientStart: CGPoint // normalized 0...1
    let gradientEnd: CGPoint   // normalized 0...1
    let glowA: (center: CGPoint, radius: CGFloat, color: CGColor)
    let glowB: (center: CGPoint, radius: CGFloat, color: CGColor)
    let glyphTop: CGColor
    let glyphBottom: CGColor
    let glyphShadow: CGColor
    let rimAlpha: CGFloat
    let sheenAlpha: CGFloat
    let trackingFactor: CGFloat
}

func makeMonogramPath(_ text: String, fontSize: CGFloat, tracking: CGFloat) -> CGPath {
    let baseFont = NSFont.systemFont(ofSize: fontSize, weight: .bold)
    let font: CTFont
    if let roundedDesc = baseFont.fontDescriptor.withDesign(.rounded),
       let roundedFont = NSFont(descriptor: roundedDesc, size: fontSize) {
        font = roundedFont as CTFont
    } else {
        font = baseFont as CTFont
    }

    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .kern: tracking,
    ]
    let attrStr = NSAttributedString(string: text, attributes: attrs)
    let line = CTLineCreateWithAttributedString(attrStr)
    let runs = (CTLineGetGlyphRuns(line) as? [CTRun]) ?? []

    let combined = CGMutablePath()
    for run in runs {
        let count = CTRunGetGlyphCount(run)
        guard count > 0 else { continue }
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRangeMake(0, count), &glyphs)
        CTRunGetPositions(run, CFRangeMake(0, count), &positions)

        let runAttrs = CTRunGetAttributes(run) as NSDictionary
        let runFont = (runAttrs[kCTFontAttributeName as NSString] as! CTFont?) ?? font

        for i in 0..<count {
            if let glyphPath = CTFontCreatePathForGlyph(runFont, glyphs[i], nil) {
                let transform = CGAffineTransform(translationX: positions[i].x, y: positions[i].y)
                combined.addPath(glyphPath, transform: transform)
            }
        }
    }
    return combined
}

func drawMonogramBadge(size: Int, palette: BadgePalette) -> CGContext {
    let ctx = makeContext(size: size)
    let s = CGFloat(size)
    let card = CGRect(x: 0, y: 0, width: s, height: s)
    let bgPath = squirclePath(in: card, radius: s * 0.225)

    ctx.saveGState()
    ctx.addPath(bgPath)
    ctx.clip()

    // Base surface gradient
    drawLinearGradient(
        ctx,
        colors: palette.gradientColors,
        locations: palette.gradientLocations,
        start: CGPoint(x: s * palette.gradientStart.x, y: s * palette.gradientStart.y),
        end: CGPoint(x: s * palette.gradientEnd.x, y: s * palette.gradientEnd.y)
    )

    // Layered ambient radial lighting
    drawRadialGlow(
        ctx,
        center: CGPoint(x: s * palette.glowA.center.x, y: s * palette.glowA.center.y),
        radius: s * palette.glowA.radius,
        inner: palette.glowA.color,
        outer: color(0, 0, 0, 0)
    )
    drawRadialGlow(
        ctx,
        center: CGPoint(x: s * palette.glowB.center.x, y: s * palette.glowB.center.y),
        radius: s * palette.glowB.radius,
        inner: palette.glowB.color,
        outer: color(0, 0, 0, 0)
    )

    // Subtle Apple top glass sheen matching app.png
    drawLinearGradient(
        ctx,
        colors: [color(255, 255, 255, 0.0), color(255, 255, 255, palette.sheenAlpha)],
        locations: [0.0, 1.0],
        start: CGPoint(x: s * 0.5, y: s * 0.50),
        end: CGPoint(x: s * 0.5, y: s)
    )

    // Optically centered, uniform-cap-height SF Pro Rounded Bold monogram
    let fontSize = s * 0.49
    let rawPath = makeMonogramPath(palette.monogram, fontSize: fontSize, tracking: fontSize * palette.trackingFactor)
    let rawBounds = rawPath.boundingBoxOfPath
    let maxWidth = s * 0.68
    let fitScale = rawBounds.width > maxWidth ? (maxWidth / rawBounds.width) : 1.0

    var fitTransform = CGAffineTransform(scaleX: fitScale, y: fitScale)
    let scaledPath = rawPath.copy(using: &fitTransform) ?? rawPath
    let bounds = scaledPath.boundingBoxOfPath

    let tx = (s - bounds.width) * 0.5 - bounds.minX
    let ty = (s - bounds.height) * 0.5 - bounds.minY
    var centerTransform = CGAffineTransform(translationX: tx, y: ty)
    let centeredPath = scaledPath.copy(using: &centerTransform) ?? scaledPath
    let glyphBox = centeredPath.boundingBoxOfPath

    // Crisp elevated shadow under the monogram
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.018), blur: s * 0.038, color: palette.glyphShadow)
    ctx.addPath(centeredPath)
    ctx.setFillColor(palette.glyphBottom)
    ctx.fillPath()
    ctx.restoreGState()

    // Subtle vertical luminance gradient on the letterforms
    ctx.saveGState()
    ctx.addPath(centeredPath)
    ctx.clip()
    drawLinearGradient(
        ctx,
        colors: [palette.glyphBottom, palette.glyphTop],
        locations: [0.0, 1.0],
        start: CGPoint(x: glyphBox.midX, y: glyphBox.minY),
        end: CGPoint(x: glyphBox.midX, y: glyphBox.maxY)
    )
    ctx.restoreGState()

    ctx.restoreGState()
    drawRimHighlight(ctx, path: bgPath, width: max(1.5, s * 0.015), alpha: palette.rimAlpha)
    return ctx
}

// MARK: - 2. Claude Code Fallback Badge (Warm terracotta squircle + "CL" monogram)

func drawClaudeIcon(size: Int) -> CGContext {
    drawMonogramBadge(size: size, palette: BadgePalette(
        monogram: "CL",
        gradientColors: [color(178, 74, 42), color(217, 119, 87), color(236, 150, 118)],
        gradientLocations: [0.0, 0.54, 1.0],
        gradientStart: CGPoint(x: 0.5, y: 0.0),
        gradientEnd: CGPoint(x: 0.5, y: 1.0),
        glowA: (CGPoint(x: 0.26, y: 0.82), 0.72, color(255, 232, 212, 0.24)),
        glowB: (CGPoint(x: 0.80, y: 0.16), 0.62, color(128, 38, 16, 0.22)),
        glyphTop: color(255, 255, 255, 1.0),
        glyphBottom: color(255, 240, 228, 0.98),
        glyphShadow: color(115, 36, 14, 0.36),
        rimAlpha: 0.24,
        sheenAlpha: 0.09,
        trackingFactor: -0.025
    ))
}

// MARK: - 3. Codex Fallback Badge (Obsidian-graphite squircle with emerald aura + "CX" monogram)

func drawCodexIcon(size: Int) -> CGContext {
    drawMonogramBadge(size: size, palette: BadgePalette(
        monogram: "CX",
        gradientColors: [color(13, 15, 20), color(26, 29, 38), color(46, 51, 64)],
        gradientLocations: [0.0, 0.52, 1.0],
        gradientStart: CGPoint(x: 0.5, y: 0.0),
        gradientEnd: CGPoint(x: 0.5, y: 1.0),
        glowA: (CGPoint(x: 0.78, y: 0.84), 0.70, color(16, 185, 129, 0.26)),
        glowB: (CGPoint(x: 0.22, y: 0.18), 0.64, color(148, 163, 184, 0.14)),
        glyphTop: color(255, 255, 255, 1.0),
        glyphBottom: color(226, 234, 244, 0.98),
        glyphShadow: color(0, 0, 0, 0.52),
        rimAlpha: 0.28,
        sheenAlpha: 0.08,
        trackingFactor: -0.025
    ))
}

// MARK: - 4. Antigravity Fallback Badge (Electric cobalt-violet squircle + "AG" monogram)

func drawAgyIcon(size: Int) -> CGContext {
    drawMonogramBadge(size: size, palette: BadgePalette(
        monogram: "AG",
        gradientColors: [color(29, 78, 216), color(79, 70, 229), color(139, 92, 246)],
        gradientLocations: [0.0, 0.52, 1.0],
        gradientStart: CGPoint(x: 0.08, y: 0.05),
        gradientEnd: CGPoint(x: 0.92, y: 0.95),
        glowA: (CGPoint(x: 0.24, y: 0.82), 0.72, color(56, 189, 248, 0.36)),
        glowB: (CGPoint(x: 0.82, y: 0.20), 0.62, color(192, 132, 252, 0.30)),
        glyphTop: color(255, 255, 255, 1.0),
        glyphBottom: color(232, 241, 255, 0.98),
        glyphShadow: color(20, 18, 72, 0.42),
        rimAlpha: 0.25,
        sheenAlpha: 0.09,
        trackingFactor: -0.030
    ))
}

// MARK: - ICNS Writer (standard Apple PNG-chunk ICNS container)

func pngData(from ctx: CGContext) throws -> Data {
    guard let image = ctx.makeImage() else {
        throw NSError(domain: "IconGen", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create CGImage"])
    }
    let data = NSMutableData()
    let type = UTType.png.identifier as CFString
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, type, 1, nil) else {
        throw NSError(domain: "IconGen", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create PNG encoder"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) {
        throw NSError(domain: "IconGen", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to finalize PNG"])
    }
    return data as Data
}

func appendUInt32BE(_ data: inout Data, _ value: UInt32) {
    var be = value.bigEndian
    withUnsafeBytes(of: &be) { data.append(contentsOf: $0) }
}

func writeICNS(to url: URL) throws {
    // Slim Retina-ready PNG-embedded ICNS chunks (16px through 512px) for notifications & System Settings.
    let chunks: [(String, Int)] = [
        ("icp4", 16),
        ("ic11", 32),
        ("ic12", 64),
        ("ic07", 128),
        ("ic13", 256),
        ("ic14", 512),
    ]
    var body = Data()
    for (tag, px) in chunks {
        let blob = try pngData(from: drawAppIcon(size: px, macOSGridInset: true))
        body.append(contentsOf: tag.utf8)
        appendUInt32BE(&body, UInt32(8 + blob.count))
        body.append(blob)
    }

    var file = Data("icns".utf8)
    appendUInt32BE(&file, UInt32(8 + body.count))
    file.append(body)
    try file.write(to: url)
}

// MARK: - CLI Entrypoint

let args = CommandLine.arguments
let outDir = URL(fileURLWithPath: args.count > 1 ? args[1] : FileManager.default.currentDirectoryPath, isDirectory: true)
let fm = FileManager.default
try fm.createDirectory(at: outDir, withIntermediateDirectories: true)

// 1. 256x256 PNG badges for notification attachments & sidebar fallbacks
try savePNG(drawAppIcon(size: 256, macOSGridInset: false), to: outDir.appendingPathComponent("app.png"))
try savePNG(drawClaudeIcon(size: 256), to: outDir.appendingPathComponent("claude.png"))
try savePNG(drawCodexIcon(size: 256), to: outDir.appendingPathComponent("codex.png"))
try savePNG(drawAgyIcon(size: 256), to: outDir.appendingPathComponent("agy.png"))

// 2. Multi-resolution macOS AppIcon.icns for AgentSessionNotifier.app
try writeICNS(to: outDir.appendingPathComponent("AppIcon.icns"))

print("Generated icons + AppIcon.icns in \(outDir.path)")
