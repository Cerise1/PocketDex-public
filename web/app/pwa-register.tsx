"use client";

import { useEffect } from "react";
import { PWA_VERSION } from "./pwa-version";

export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    const resetKey = "pocketdex.pwa.version";
    const versionedSw = `/sw.js?v=${PWA_VERSION}`;
    const hadSameVersion = window.localStorage.getItem(resetKey) === PWA_VERSION;
    const isLocalhost = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(window.location.hostname || "");

    const bootstrap = async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();

        // During local debugging, always remove service workers/caches to avoid stale bundles.
        if (isLocalhost) {
          await Promise.all(registrations.map((registration) => registration.unregister()));
          if ("caches" in window) {
            const cacheNames = await window.caches.keys();
            await Promise.all(cacheNames.map((name) => window.caches.delete(name)));
          }
          window.localStorage.setItem(resetKey, PWA_VERSION);
          return;
        }

        if (!hadSameVersion && "caches" in window) {
          const cacheNames = await window.caches.keys();
          await Promise.all(cacheNames.map((name) => window.caches.delete(name)));
        }
        await Promise.all(
          registrations.map((registration) => {
            const currentScript =
              registration.active?.scriptURL ??
              registration.waiting?.scriptURL ??
              registration.installing?.scriptURL ??
              "";
            if (!currentScript.includes(`/sw.js?v=${PWA_VERSION}`)) {
              return registration.unregister();
            }
            return registration.update();
          }),
        );

        await navigator.serviceWorker.register(versionedSw, { scope: "/" });
        window.localStorage.setItem(resetKey, PWA_VERSION);
      } catch {
        // Silent fail: PWA should still run as a normal web app.
      }
    };

    void bootstrap();
  }, []);

  return null;
}
