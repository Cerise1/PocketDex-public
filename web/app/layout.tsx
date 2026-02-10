import "./globals.css";
import type { Metadata, Viewport } from "next";
import PwaRegister from "./pwa-register";
import { PWA_VERSION } from "./pwa-version";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d0e10",
};

export const metadata: Metadata = {
  title: "PocketDex",
  description: "Codex companion for threads and live runs",
  applicationName: "PocketDex",
  manifest: `/manifest.json?v=${PWA_VERSION}`,
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PocketDex",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: `/favicon.ico?v=${PWA_VERSION}`, type: "image/x-icon" },
      { url: `/favicon.svg?v=${PWA_VERSION}`, type: "image/svg+xml" },
    ],
    shortcut: `/favicon.ico?v=${PWA_VERSION}`,
    apple: `/apple-touch-icon.png?v=${PWA_VERSION}`,
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
