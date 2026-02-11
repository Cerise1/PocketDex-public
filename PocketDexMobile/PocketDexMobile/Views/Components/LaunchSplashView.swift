import SwiftUI

struct LaunchSplashView: View {
    let progress: CGFloat

    @State private var pulseDot = false

    var body: some View {
        ZStack {
            PocketDexBackground()

            VStack(spacing: 34) {
                Spacer(minLength: 0)

                VStack(spacing: 8) {
                    Text("PocketDex")
                        .font(.system(size: 56, weight: .semibold, design: .serif))
                        .tracking(-1.2)
                        .foregroundStyle(.white.opacity(0.96))
                }

                discoveryPanel

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 26)
            .padding(.top, 56)
            .padding(.bottom, 44)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Chargement de PocketDex")
    }

    private var discoveryPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(.white.opacity(0.62))
                    .frame(width: 7, height: 7)
                    .scaleEffect(pulseDot ? 1 : 0.72)
                    .opacity(pulseDot ? 1 : 0.48)
                    .shadow(color: .white.opacity(pulseDot ? 0.34 : 0.08), radius: pulseDot ? 5 : 2)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                            pulseDot = true
                        }
                    }
                    .onDisappear {
                        pulseDot = false
                    }

                Text("Syncing your project")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .tracking(1.4)
                    .foregroundStyle(.white.opacity(0.72))
            }

            ZStack(alignment: .leading) {
                Capsule()
                    .fill(.white.opacity(0.12))
                    .frame(height: 4)

                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [
                                .white.opacity(0.24),
                                .white.opacity(0.92),
                                .white.opacity(0.3),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(height: 4)
                    .scaleEffect(x: max(progress, 0.02), y: 1, anchor: .leading)
            }
            .frame(maxWidth: 270, alignment: .leading)

            HStack(spacing: 6) {
                PocketDexThinkingDots(dotSize: 4, color: .white.opacity(0.6))
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 14)
        .frame(maxWidth: 320, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            .white.opacity(0.1),
                            .white.opacity(0.02),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color(red: 0.07, green: 0.08, blue: 0.09).opacity(0.55))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(.white.opacity(0.17), lineWidth: 1)
                )
                .overlay {
                    SplashSweep()
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
        }
    }
}

private struct SplashSweep: View {
    @State private var sweepProgress: CGFloat = -1.15

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [
                            .clear,
                            .white.opacity(0.16),
                            .clear,
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: width * 1.1)
                .rotationEffect(.degrees(6))
                .offset(x: sweepProgress * width)
                .onAppear {
                    withAnimation(.linear(duration: 2.9).repeatForever(autoreverses: false)) {
                        sweepProgress = 1.1
                    }
                }
                .onDisappear {
                    sweepProgress = -1.15
                }
        }
        .allowsHitTesting(false)
    }
}
