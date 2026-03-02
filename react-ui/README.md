# ZO UI Example

A React example app that integrates the [ZO Finance](https://zofai.io) trading widget with Sui wallet connectivity.

## Stack

- **React 18** + **TypeScript** + **Vite**
- **@zofai/trading-widget** – ZO trading UI and components
- **@mysten/dapp-kit-react** + **@mysten/sui** – Sui wallet connection (mainnet)
- **UnoCSS** – styling (Tailwind-style utilities + shadcn preset)
- **Jotai** – state (via widget `appStore`)
- **TanStack Query** – data fetching

## Setup

```bash
pnpm install
```

## Scripts

| Command   | Description              |
| --------- | ------------------------- |
| `pnpm dev`      | Start dev server (Vite)   |
| `pnpm build`    | Production build          |
| `pnpm preview`  | Preview production build  |

## Project structure

- `src/main.tsx` – App bootstrap: Jotai, React Query, DAppKit, and root `<App />`
- `src/App.tsx` – Layout with header (brand, RPC settings, connect button) and full-height `<TradingWidget />`
- `src/dapp-kit.ts` – Mysten dApp Kit config (Sui mainnet/testnet gRPC URLs and type registration)

## Requirements

- The widget expects to run inside the providers set up in `main.tsx`: `JotaiProvider` (with `appStore`), `QueryClientProvider`, and `DAppKitProvider`.
- Import the widget styles: `@zofai/trading-widget/style.css`
