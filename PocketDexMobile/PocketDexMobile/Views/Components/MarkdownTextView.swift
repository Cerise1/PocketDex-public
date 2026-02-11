import SwiftUI
import UIKit

struct MarkdownTextView: UIViewRepresentable {
    private struct ParsedFileReference {
        let path: String
        let line: Int
        let column: Int?
    }

    final class Coordinator {
        var lastRenderKey: String?
    }

    private static let fileReferenceCandidatePattern =
        #"[A-Za-z0-9_./\\:-]+\.[A-Za-z][A-Za-z0-9]*(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)"#
    private static let attributedTextCache: NSCache<NSString, NSAttributedString> = {
        let cache = NSCache<NSString, NSAttributedString>()
        cache.countLimit = 220
        return cache
    }()
    private static let longMarkdownFastPathThreshold = 8_000
    private static let fileReferenceFormattingLimit = 16_000
    private static let fallbackScreenHorizontalPadding: CGFloat = 56

    let markdown: String
    var textStyle: UIFont.TextStyle = .body
    var textColor: UIColor = .white
    var linkColor: UIColor = UIColor(red: 0.46, green: 0.79, blue: 0.98, alpha: 1.0)
    var allowsSelection = true

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.backgroundColor = .clear
        view.isEditable = false
        view.isScrollEnabled = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.required, for: .vertical)
        view.textContainer.lineBreakMode = .byWordWrapping
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        uiView.isSelectable = allowsSelection
        let baseFont = UIFont.preferredFont(forTextStyle: textStyle)
        uiView.font = baseFont
        uiView.textColor = textColor
        uiView.linkTextAttributes = [.foregroundColor: linkColor]
        applyRenderedTextIfNeeded(to: uiView, context: context, baseFont: baseFont)
    }

    @available(iOS 16.0, *)
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let baseFont = UIFont.preferredFont(forTextStyle: textStyle)
        applyRenderedTextIfNeeded(to: uiView, context: context, baseFont: baseFont)
        let source = normalizedMarkdown(markdown)
        let hasText = hasRenderableText(source)

        let width = resolvedFittingWidth(proposalWidth: proposal.width, uiView: uiView)
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let minimumHeight = hasText
            ? ceil(baseFont.lineHeight + uiView.textContainerInset.top + uiView.textContainerInset.bottom)
            : 1
        let resolvedHeight = max(ceil(fitting.height), minimumHeight)
        return CGSize(width: width, height: resolvedHeight)
    }

    private func applyRenderedTextIfNeeded(to uiView: UITextView, context: Context, baseFont: UIFont) {
        let source = normalizedMarkdown(markdown)
        let key = renderCacheKey(source: source, baseFont: baseFont)
        let hasRenderableText = hasRenderableText(source)
        if context.coordinator.lastRenderKey == key {
            // Keep the fast-path, but recover from empty-height cases by ensuring text exists.
            if !hasRenderableText || uiView.attributedText.length > 0 {
                return
            }
        }

        let attributedText: NSAttributedString
        if let cached = Self.attributedTextCache.object(forKey: key as NSString) {
            attributedText = cached
        } else {
            let rendered = makeAttributedText(source: source, baseFont: baseFont)
            Self.attributedTextCache.setObject(rendered, forKey: key as NSString, cost: rendered.length)
            attributedText = rendered
        }

        context.coordinator.lastRenderKey = key
        uiView.attributedText = attributedText
        uiView.layoutManager.ensureLayout(for: uiView.textContainer)
        uiView.invalidateIntrinsicContentSize()
        uiView.setNeedsLayout()
    }

    private func makeAttributedText(source: String, baseFont: UIFont) -> NSAttributedString {
        guard !source.isEmpty else { return NSAttributedString(string: "") }
        if source.count >= Self.longMarkdownFastPathThreshold {
            return makePlainTextAttributedText(from: source, baseFont: baseFont)
        }
        if shouldUseStructuredRenderer(for: source) {
            return makeStructuredMarkdownAttributedText(from: source, baseFont: baseFont)
        }

        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )

        if let attributed = try? AttributedString(markdown: source, options: options) {
            let result = NSMutableAttributedString(attributedString: NSAttributedString(attributed))
            let fullRange = NSRange(location: 0, length: result.length)
            result.addAttribute(.foregroundColor, value: textColor, range: fullRange)
            applyFontScaling(to: result, baseFont: baseFont)
            applyParagraphTweaks(to: result, range: fullRange)
            applyFileReferenceFormatting(to: result, baseFont: baseFont)
            return result
        }

        return makeStructuredMarkdownAttributedText(from: source, baseFont: baseFont)
    }

    private func makePlainTextAttributedText(from source: String, baseFont: UIFont) -> NSAttributedString {
        let rendered = NSMutableAttributedString(
            string: source,
            attributes: [
                .font: baseFont,
                .foregroundColor: textColor,
            ]
        )
        addParagraphStyle(
            to: rendered,
            style: makeParagraphStyle(lineSpacing: 3, paragraphSpacing: 7)
        )
        applyFileReferenceFormatting(to: rendered, baseFont: baseFont)
        return rendered
    }

    private func renderCacheKey(source: String, baseFont: UIFont) -> String {
        let sourceHash = stableHash(of: source)
        let fontPointSize = String(format: "%.3f", baseFont.pointSize)
        return [
            textStyle.rawValue,
            fontPointSize,
            textColor.cacheKeyFragment,
            linkColor.cacheKeyFragment,
            sourceHash,
        ].joined(separator: "|")
    }

    private func stableHash(of value: String) -> String {
        var hasher = Hasher()
        hasher.combine(value)
        return String(hasher.finalize(), radix: 16)
    }

    private func normalizedMarkdown(_ source: String) -> String {
        source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{2028}", with: "\n")
            .replacingOccurrences(of: "\u{2029}", with: "\n")
    }

    private func hasRenderableText(_ source: String) -> Bool {
        !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func resolvedFittingWidth(proposalWidth: CGFloat?, uiView: UITextView) -> CGFloat {
        if let proposalWidth, proposalWidth.isFinite, proposalWidth > 1 {
            return proposalWidth
        }

        let boundsWidth = uiView.bounds.width
        if boundsWidth.isFinite, boundsWidth > 1 {
            return boundsWidth
        }

        if let superviewWidth = uiView.superview?.bounds.width,
           superviewWidth.isFinite,
           superviewWidth > 1
        {
            return superviewWidth
        }

        if let windowWidth = uiView.window?.bounds.width,
           windowWidth.isFinite,
           windowWidth > 1
        {
            return max(1, windowWidth - Self.fallbackScreenHorizontalPadding)
        }

        let screenWidth = UIScreen.main.bounds.width
        if screenWidth.isFinite, screenWidth > 1 {
            return max(1, screenWidth - Self.fallbackScreenHorizontalPadding)
        }

        return 1
    }

    private func shouldUseStructuredRenderer(for source: String) -> Bool {
        let hasStructuralMarkdown =
            source.range(of: #"(?m)^\s*(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+|>\s+|```)"#, options: .regularExpression) != nil
        if hasStructuralMarkdown {
            return true
        }
        if source.contains("`") || source.contains("**") || source.contains("[") {
            return true
        }
        return false
    }

    private func makeStructuredMarkdownAttributedText(from source: String, baseFont: UIFont) -> NSAttributedString {
        let bodyColor = textColor
        let output = NSMutableAttributedString()
        let lines = source.components(separatedBy: "\n")
        var index = 0

        while index < lines.count {
            let rawLine = lines[index].replacingOccurrences(of: "\t", with: "    ")
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                var codeLines: [String] = []
                index += 1
                while index < lines.count {
                    let candidate = lines[index].replacingOccurrences(of: "\t", with: "    ")
                    if candidate.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        break
                    }
                    codeLines.append(candidate)
                    index += 1
                }
                appendCodeBlock(
                    codeLines.joined(separator: "\n"),
                    into: output,
                    baseFont: baseFont,
                    color: bodyColor
                )
                if index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    index += 1
                }
                continue
            }

            if trimmed.isEmpty {
                output.append(
                    NSAttributedString(
                        string: "\n",
                        attributes: [
                            .font: baseFont,
                            .foregroundColor: bodyColor,
                        ]
                    )
                )
                index += 1
                continue
            }

            if let heading = parseHeadingLine(rawLine) {
                let headingSize = max(baseFont.pointSize + CGFloat(max(1, 6 - heading.level)), baseFont.pointSize + 1)
                let headingFont = UIFont.systemFont(ofSize: headingSize, weight: .semibold)
                let styled = makeInlineAttributedText(heading.text, baseFont: headingFont, color: bodyColor)
                addParagraphStyle(
                    to: styled,
                    style: makeParagraphStyle(lineSpacing: 3, paragraphSpacing: 11)
                )
                output.append(styled)
                output.append(NSAttributedString(string: "\n", attributes: [.font: baseFont, .foregroundColor: bodyColor]))
                index += 1
                continue
            }

            if let unordered = parseUnorderedListLine(rawLine) {
                let prefix = "• "
                let prefixWidth = (prefix as NSString).size(withAttributes: [.font: baseFont]).width
                let indent = CGFloat(unordered.leadingWhitespace) * 3.8
                let styled = NSMutableAttributedString(
                    string: prefix,
                    attributes: [
                        .font: UIFont.systemFont(ofSize: baseFont.pointSize, weight: .semibold),
                        .foregroundColor: bodyColor,
                    ]
                )
                styled.append(makeInlineAttributedText(unordered.text, baseFont: baseFont, color: bodyColor))
                addParagraphStyle(
                    to: styled,
                    style: makeParagraphStyle(
                        lineSpacing: 3,
                        paragraphSpacing: 8,
                        firstLineHeadIndent: indent,
                        headIndent: indent + prefixWidth
                    )
                )
                output.append(styled)
                output.append(NSAttributedString(string: "\n", attributes: [.font: baseFont, .foregroundColor: bodyColor]))
                index += 1
                continue
            }

            if let ordered = parseOrderedListLine(rawLine) {
                let prefix = "\(ordered.number). "
                let prefixWidth = (prefix as NSString).size(withAttributes: [.font: baseFont]).width
                let indent = CGFloat(ordered.leadingWhitespace) * 3.8
                let styled = NSMutableAttributedString(
                    string: prefix,
                    attributes: [
                        .font: UIFont.systemFont(ofSize: baseFont.pointSize, weight: .semibold),
                        .foregroundColor: bodyColor,
                    ]
                )
                styled.append(makeInlineAttributedText(ordered.text, baseFont: baseFont, color: bodyColor))
                addParagraphStyle(
                    to: styled,
                    style: makeParagraphStyle(
                        lineSpacing: 3,
                        paragraphSpacing: 8,
                        firstLineHeadIndent: indent,
                        headIndent: indent + prefixWidth
                    )
                )
                output.append(styled)
                output.append(NSAttributedString(string: "\n", attributes: [.font: baseFont, .foregroundColor: bodyColor]))
                index += 1
                continue
            }

            if let quote = parseQuoteLine(rawLine) {
                let styled = NSMutableAttributedString(
                    string: "▌ ",
                    attributes: [
                        .font: UIFont.systemFont(ofSize: baseFont.pointSize, weight: .semibold),
                        .foregroundColor: bodyColor.withAlphaComponent(0.72),
                    ]
                )
                styled.append(makeInlineAttributedText(quote.text, baseFont: baseFont, color: bodyColor.withAlphaComponent(0.92)))
                addParagraphStyle(
                    to: styled,
                    style: makeParagraphStyle(
                        lineSpacing: 3,
                        paragraphSpacing: 9,
                        firstLineHeadIndent: CGFloat(quote.leadingWhitespace) * 3.8,
                        headIndent: CGFloat(quote.leadingWhitespace) * 3.8 + 12
                    )
                )
                output.append(styled)
                output.append(NSAttributedString(string: "\n", attributes: [.font: baseFont, .foregroundColor: bodyColor]))
                index += 1
                continue
            }

            let paragraph = makeInlineAttributedText(rawLine, baseFont: baseFont, color: bodyColor)
            addParagraphStyle(
                to: paragraph,
                style: makeParagraphStyle(lineSpacing: 3, paragraphSpacing: 9)
            )
            output.append(paragraph)
            output.append(NSAttributedString(string: "\n", attributes: [.font: baseFont, .foregroundColor: bodyColor]))
            index += 1
        }

        trimTrailingNewlines(from: output)
        applyFileReferenceFormatting(to: output, baseFont: baseFont)
        return output
    }

    private func trimTrailingNewlines(from text: NSMutableAttributedString) {
        while text.length > 0 {
            let lastRange = NSRange(location: text.length - 1, length: 1)
            let lastCharacter = (text.string as NSString).substring(with: lastRange)
            if lastCharacter == "\n" || lastCharacter == "\r" {
                text.deleteCharacters(in: lastRange)
                continue
            }
            break
        }
    }

    private func appendCodeBlock(_ text: String, into output: NSMutableAttributedString, baseFont: UIFont, color: UIColor) {
        let codeFont = UIFont.monospacedSystemFont(ofSize: max(11, baseFont.pointSize * 0.88), weight: .regular)
        let codeBackground = UIColor(red: 0.11, green: 0.13, blue: 0.17, alpha: 0.9)
        let blockText = text.isEmpty ? " " : text
        let padded = "  \(blockText.replacingOccurrences(of: "\n", with: "\n  "))  "
        let attributed = NSMutableAttributedString(
            string: padded,
            attributes: [
                .font: codeFont,
                .foregroundColor: color.withAlphaComponent(0.94),
                .backgroundColor: codeBackground,
            ]
        )
        addParagraphStyle(
            to: attributed,
            style: makeParagraphStyle(
                lineSpacing: 2,
                paragraphSpacing: 11,
                firstLineHeadIndent: 0,
                headIndent: 0,
                paragraphSpacingBefore: 2
            )
        )
        output.append(attributed)
        output.append(
            NSAttributedString(
                string: "\n",
                attributes: [
                    .font: baseFont,
                    .foregroundColor: color,
                ]
            )
        )
    }

    private func makeInlineAttributedText(_ text: String, baseFont: UIFont, color: UIColor) -> NSMutableAttributedString {
        let output = NSMutableAttributedString()
        var index = text.startIndex

        while index < text.endIndex {
            if text[index] == "`", let close = text[text.index(after: index)...].firstIndex(of: "`") {
                let code = String(text[text.index(after: index)..<close])
                let codeText = code.isEmpty ? " " : code
                output.append(
                    NSAttributedString(
                        string: codeText,
                        attributes: [
                            .font: UIFont.monospacedSystemFont(ofSize: max(11, baseFont.pointSize * 0.88), weight: .medium),
                            .foregroundColor: color.withAlphaComponent(0.95),
                            .backgroundColor: UIColor(red: 0.15, green: 0.18, blue: 0.23, alpha: 0.95),
                        ]
                    )
                )
                index = text.index(after: close)
                continue
            }

            if text[index] == "*",
               text.index(after: index) < text.endIndex,
               text[text.index(after: index)] == "*",
               let close = text.range(of: "**", range: text.index(index, offsetBy: 2)..<text.endIndex)
            {
                let inner = String(text[text.index(index, offsetBy: 2)..<close.lowerBound])
                output.append(
                    makeInlineAttributedText(
                        inner,
                        baseFont: UIFont.systemFont(ofSize: baseFont.pointSize, weight: .semibold),
                        color: color
                    )
                )
                index = close.upperBound
                continue
            }

            if text[index] == "[",
               let closingBracket = text[index...].firstIndex(of: "]"),
               closingBracket < text.endIndex,
               text.index(after: closingBracket) < text.endIndex,
               text[text.index(after: closingBracket)] == "(",
               let closingParen = text[text.index(closingBracket, offsetBy: 2)...].firstIndex(of: ")")
            {
                let label = String(text[text.index(after: index)..<closingBracket])
                output.append(
                    NSAttributedString(
                        string: label,
                        attributes: [
                            .font: baseFont,
                            .foregroundColor: linkColor,
                        ]
                    )
                )
                index = text.index(after: closingParen)
                continue
            }

            let remaining = text[index..<text.endIndex]
            let nextBacktick = remaining.firstIndex(of: "`")
            let nextBracket = remaining.firstIndex(of: "[")
            let nextBold = text.range(of: "**", range: index..<text.endIndex)?.lowerBound
            let nextMarker = [nextBacktick, nextBracket, nextBold]
                .compactMap { $0 }
                .min() ?? text.endIndex

            let chunkEnd = nextMarker > index ? nextMarker : text.index(after: index)
            let chunk = String(text[index..<chunkEnd])
            output.append(
                NSAttributedString(
                    string: chunk,
                    attributes: [
                        .font: baseFont,
                        .foregroundColor: color,
                    ]
                )
            )
            index = chunkEnd
        }

        return output
    }

    private func parseHeadingLine(_ line: String) -> (level: Int, text: String)? {
        let leading = line.prefix(while: { $0 == " " })
        let trimmed = String(line.dropFirst(leading.count))
        guard trimmed.hasPrefix("#") else { return nil }
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let contentStart = trimmed.index(trimmed.startIndex, offsetBy: hashes)
        guard contentStart < trimmed.endIndex, trimmed[contentStart] == " " else { return nil }
        let text = String(trimmed[trimmed.index(after: contentStart)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return (hashes, text)
    }

    private func parseUnorderedListLine(_ line: String) -> (leadingWhitespace: Int, text: String)? {
        let leading = line.prefix(while: { $0 == " " })
        let trimmed = String(line.dropFirst(leading.count))
        guard trimmed.count >= 2 else { return nil }
        guard let marker = trimmed.first, marker == "-" || marker == "*" || marker == "+" else { return nil }
        guard trimmed.dropFirst().first == " " else { return nil }
        let text = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return (leading.count, text)
    }

    private func parseOrderedListLine(_ line: String) -> (leadingWhitespace: Int, number: String, text: String)? {
        let leading = line.prefix(while: { $0 == " " })
        let trimmed = String(line.dropFirst(leading.count))
        let digits = trimmed.prefix(while: { $0.isNumber })
        guard !digits.isEmpty else { return nil }
        guard digits.count < trimmed.count else { return nil }
        let dotIndex = trimmed.index(trimmed.startIndex, offsetBy: digits.count)
        guard trimmed[dotIndex] == "." else { return nil }
        let afterDot = trimmed.index(after: dotIndex)
        guard afterDot < trimmed.endIndex, trimmed[afterDot] == " " else { return nil }
        let text = String(trimmed[trimmed.index(after: afterDot)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return (leading.count, String(digits), text)
    }

    private func parseQuoteLine(_ line: String) -> (leadingWhitespace: Int, text: String)? {
        let leading = line.prefix(while: { $0 == " " })
        let trimmed = String(line.dropFirst(leading.count))
        guard trimmed.hasPrefix("> ") else { return nil }
        let text = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return (leading.count, text)
    }

    private func makeParagraphStyle(
        lineSpacing: CGFloat,
        paragraphSpacing: CGFloat,
        firstLineHeadIndent: CGFloat = 0,
        headIndent: CGFloat = 0,
        paragraphSpacingBefore: CGFloat = 0
    ) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        style.lineSpacing = lineSpacing
        style.paragraphSpacing = paragraphSpacing
        style.paragraphSpacingBefore = paragraphSpacingBefore
        style.firstLineHeadIndent = firstLineHeadIndent
        style.headIndent = headIndent
        return style
    }

    private func addParagraphStyle(to text: NSMutableAttributedString, style: NSParagraphStyle) {
        guard text.length > 0 else { return }
        text.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: text.length))
    }

    private func applyParagraphTweaks(to text: NSMutableAttributedString, range: NSRange) {
        text.enumerateAttribute(.paragraphStyle, in: range, options: []) { value, segmentRange, _ in
            let paragraph = (value as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle ?? NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byWordWrapping
            paragraph.lineSpacing = max(paragraph.lineSpacing, 1)
            paragraph.paragraphSpacing = max(paragraph.paragraphSpacing, 4)
            text.addAttribute(.paragraphStyle, value: paragraph, range: segmentRange)
        }
    }

    private func applyFontScaling(to text: NSMutableAttributedString, baseFont: UIFont) {
        let fullRange = NSRange(location: 0, length: text.length)
        guard fullRange.length > 0 else { return }

        let bodyFont = UIFont.preferredFont(forTextStyle: .body)
        let scaleFactor = max(0.8, baseFont.pointSize / max(bodyFont.pointSize, 1))

        text.enumerateAttribute(.font, in: fullRange, options: []) { value, segmentRange, _ in
            if let font = value as? UIFont {
                let scaled = font.withSize(max(11, font.pointSize * scaleFactor))
                text.addAttribute(.font, value: scaled, range: segmentRange)
            } else {
                text.addAttribute(.font, value: baseFont, range: segmentRange)
            }
        }
    }

    private func applyFileReferenceFormatting(to text: NSMutableAttributedString, baseFont: UIFont) {
        guard text.length > 0 else { return }
        guard text.length <= Self.fileReferenceFormattingLimit else { return }
        guard let regex = try? NSRegularExpression(pattern: Self.fileReferenceCandidatePattern) else { return }

        let fullRange = NSRange(location: 0, length: text.length)
        let matches = regex.matches(in: text.string, options: [], range: fullRange)

        for match in matches.reversed() {
            let nsString = text.string as NSString
            let raw = nsString.substring(with: match.range)
            guard let reference = parseFileReference(raw) else { continue }

            let label = formatFileReferenceLabel(reference)
            let replacement = NSAttributedString(
                string: label,
                attributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: max(11, baseFont.pointSize * 0.93), weight: .semibold),
                    .foregroundColor: linkColor,
                ]
            )
            text.replaceCharacters(in: match.range, with: replacement)
        }
    }

    private func parseFileReference(_ value: String) -> ParsedFileReference? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard !trimmed.contains("://") else { return nil }

        func build(path: String, line: String, column: String?) -> ParsedFileReference? {
            let cleanedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "),.;"))
            guard isLikelyFilePath(cleanedPath) else { return nil }
            guard let lineValue = Int(line), lineValue > 0 else { return nil }
            var columnValue: Int? = nil
            if let column, !column.isEmpty {
                guard let parsedColumn = Int(column), parsedColumn > 0 else { return nil }
                columnValue = parsedColumn
            }
            return ParsedFileReference(path: cleanedPath, line: lineValue, column: columnValue)
        }

        if let hashRange = trimmed.range(of: #"#L(\d+)(?:C(\d+))?$"#, options: .regularExpression) {
            let path = String(trimmed[..<hashRange.lowerBound])
            let suffix = String(trimmed[hashRange.lowerBound...])
            let pattern = #"#L(\d+)(?:C(\d+))?$"#
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(in: suffix, range: NSRange(location: 0, length: (suffix as NSString).length))
            {
                let ns = suffix as NSString
                let line = ns.substring(with: match.range(at: 1))
                let column = match.range(at: 2).location != NSNotFound ? ns.substring(with: match.range(at: 2)) : nil
                return build(path: path, line: line, column: column)
            }
        }

        let colonPattern = #"^(.*):(\d+)(?::(\d+))?$"#
        if let regex = try? NSRegularExpression(pattern: colonPattern),
           let match = regex.firstMatch(in: trimmed, range: NSRange(location: 0, length: (trimmed as NSString).length))
        {
            let ns = trimmed as NSString
            let path = ns.substring(with: match.range(at: 1))
            let line = ns.substring(with: match.range(at: 2))
            let column = match.range(at: 3).location != NSNotFound ? ns.substring(with: match.range(at: 3)) : nil
            return build(path: path, line: line, column: column)
        }

        return nil
    }

    private func isLikelyFilePath(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        guard !value.contains("://") else { return false }
        let file = basename(value)
        return file.range(of: #"\.[A-Za-z][A-Za-z0-9]{0,15}$"#, options: .regularExpression) != nil
    }

    private func basename(_ value: String) -> String {
        let normalized = value.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map(String.init) ?? value
    }

    private func formatFileReferenceLabel(_ reference: ParsedFileReference) -> String {
        if let column = reference.column {
            return "\(basename(reference.path)) (line \(reference.line):\(column))"
        }
        return "\(basename(reference.path)) (line \(reference.line))"
    }
}

private extension UIColor {
    var cacheKeyFragment: String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        if getRed(&red, green: &green, blue: &blue, alpha: &alpha) {
            return String(
                format: "%.4f-%.4f-%.4f-%.4f",
                red,
                green,
                blue,
                alpha
            )
        }
        return description
    }
}
