import SwiftUI

enum PocketDexTheme {
    static let backgroundTop = Color(red: 0.10, green: 0.10, blue: 0.11)
    static let backgroundMid = Color(red: 0.07, green: 0.07, blue: 0.08)
    static let backgroundBottom = Color(red: 0.05, green: 0.05, blue: 0.06)

    static let surface = Color(red: 0.10, green: 0.10, blue: 0.11).opacity(0.92)
    static let elevatedSurface = Color(red: 0.13, green: 0.13, blue: 0.14).opacity(0.94)
    static let mutedSurface = Color.white.opacity(0.06)
    static let border = Color.white.opacity(0.10)
    static let secondaryText = Color.white.opacity(0.66)
}

struct PocketDexBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    PocketDexTheme.backgroundTop,
                    PocketDexTheme.backgroundMid,
                    PocketDexTheme.backgroundBottom,
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            RadialGradient(
                colors: [Color.white.opacity(0.14), Color.clear],
                center: .top,
                startRadius: 0,
                endRadius: 340
            )
            .offset(y: -120)

            RadialGradient(
                colors: [Color.white.opacity(0.03), Color.clear],
                center: .bottomTrailing,
                startRadius: 0,
                endRadius: 420
            )
        }
        .ignoresSafeArea()
    }
}

struct PocketDexWebSpinner: View {
    let size: CGFloat
    let lineWidth: CGFloat
    let color: Color
    let revolutionDuration: TimeInterval

    init(
        size: CGFloat = 12,
        lineWidth: CGFloat = 1.8,
        color: Color = .white.opacity(0.72),
        revolutionDuration: TimeInterval = 1.35
    ) {
        self.size = size
        self.lineWidth = lineWidth
        self.color = color
        self.revolutionDuration = revolutionDuration
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: false)) { context in
            let elapsed = context.date.timeIntervalSinceReferenceDate
            let progress = (elapsed.truncatingRemainder(dividingBy: revolutionDuration)) / revolutionDuration

            Circle()
                .trim(from: 0.12, to: 0.9)
                .stroke(
                    color,
                    style: StrokeStyle(
                        lineWidth: lineWidth,
                        lineCap: .round
                    )
                )
                .frame(width: size, height: size)
                .rotationEffect(.degrees(progress * 360))
        }
    }
}

struct PocketDexThinkingDots: View {
    let dotSize: CGFloat
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(dotSize: CGFloat = 4.5, color: Color = .white.opacity(0.72)) {
        self.dotSize = dotSize
        self.color = color
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: reduceMotion ? 0.18 : (1.0 / 60.0), paused: false)) { context in
            let elapsed = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    let emphasis = dotEmphasis(for: index, elapsed: elapsed)
                    Circle()
                        .fill(color)
                        .frame(width: dotSize, height: dotSize)
                        .opacity((reduceMotion ? 0.48 : 0.28) + (reduceMotion ? 0.40 : 0.72) * emphasis)
                        .scaleEffect(reduceMotion ? 1.0 : (0.82 + (0.18 * emphasis)))
                        .offset(y: reduceMotion ? 0 : (-1.8 * emphasis))
                }
            }
        }
    }

    private func dotEmphasis(for index: Int, elapsed: TimeInterval) -> Double {
        let cycleDuration: TimeInterval = reduceMotion ? 1.8 : 1.35
        let phaseDelay: Double = 0.18
        let shifted = (elapsed / cycleDuration) - (Double(index) * phaseDelay)
        let phase = shifted - floor(shifted)
        let wave = 0.5 + 0.5 * sin((phase * (Double.pi * 2.0)) - (Double.pi / 2.0))
        return wave * wave
    }
}
