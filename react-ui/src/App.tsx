import { CustomConnectButton, RpcSettings, TradingWidget } from '@zofai/trading-widget'

export function App() {
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-950 text-white">
      {/* Top navbar */}
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-gray-800 px-4 py-2">
        {/* Brand */}
        <div className="mr-2 flex items-center gap-2">
          <div className="h-6 w-6 flex select-none items-center justify-center rounded bg-blue-500 text-xs font-bold">
            Z
          </div>
          <span className="text-sm font-semibold tracking-wide">ZO Finance</span>
        </div>

        {/* Nav links */}
        <nav className="ml-1 flex items-center gap-1">
          <button type="button" className="rounded bg-gray-800 px-3 py-1.5 text-xs text-white font-medium">Trade</button>
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Widget components need the .zo-trading-widget wrapper for their bundled styles to apply */}
        <div className="zo-trading-widget flex items-center gap-3">
          <RpcSettings />
          <CustomConnectButton />
        </div>
      </header>

      {/* Trading widget fills remaining space */}
      <main className="min-h-0 flex-1 overflow-hidden">
        <TradingWidget className="h-full" />
      </main>
    </div>
  )
}
