/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        body: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "\"SF Pro Text\"",
          "\"SF Pro Display\"",
          "\"Segoe UI\"",
          "Helvetica",
          "Arial",
          "\"Noto Sans\"",
          "\"Apple Color Emoji\"",
          "\"Segoe UI Emoji\"",
          "\"Segoe UI Symbol\"",
          "sans-serif",
        ],
        mono: ["var(--font-mono)", "monospace"],
      },
      colors: {
        "codex-bg": "#0f1011",
        "codex-panel": "#151618",
        "codex-sidebar": "#111214",
      },
      boxShadow: {
        card: "0 12px 24px rgba(0,0,0,0.35)",
        float: "0 20px 40px rgba(0,0,0,0.4)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
