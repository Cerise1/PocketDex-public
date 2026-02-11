export default function PwaRedPage() {
  return (
    <main
      className="fixed inset-0 flex items-center justify-center bg-[#ff0000] text-white"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 0px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 0px)",
        paddingLeft: "max(env(safe-area-inset-left), 0px)",
        paddingRight: "max(env(safe-area-inset-right), 0px)",
      }}
    >
      <div className="text-center">
        <div className="text-2xl font-semibold tracking-tight">PWA RED TEST</div>
        <div className="mt-2 text-sm opacity-90">/pwa-red</div>
      </div>
    </main>
  );
}
