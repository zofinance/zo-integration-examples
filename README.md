# ZO Integration Examples

Example apps for integrating with [ZO Finance](https://zofai.io) on Sui.

| Example | Path | What it shows |
|---------|------|----------------|
| **React UI** | [`react-ui/`](./react-ui) | Embed `@zofai/trading-widget` in a Vite + React app (wallet connect, RPC settings, full trading UI) |
| **Trading bot** | [`trading-bot/`](./trading-bot) | Programmatic trading with `@zofai/zo-sdk` (market / TPSL loops and a grid bot) |

Each example is a standalone package — install and run from its own directory.

## Requirements

- **Node.js** v18+
- **pnpm** (recommended) or npm
- For the bot: a Sui wallet private key and SUI for gas

## Quick start

### React UI

```bash
cd react-ui
pnpm install
pnpm dev
```

See [`react-ui/README.md`](./react-ui/README.md) for providers, styles, and layout notes.

### Trading bot

```bash
cd trading-bot
pnpm install
cp .env.example .env   # set PRIVATE_KEY (and optional NETWORK / RPC URLs)
pnpm start             # market / TPSL bot — edit index.ts first
# or
pnpm run grid          # grid bot — edit grid-bot-run.ts first
```

See [`trading-bot/README.md`](./trading-bot/README.md) for env vars, `TradeConfig`, and Pyth Pro V3 trading (`openPositionV3` / `decreasePositionV3`).

## Packages

| Package | Role |
|---------|------|
| [`@zofai/trading-widget`](https://www.npmjs.com/package/@zofai/trading-widget) | Ready-made trading UI for React |
| [`@zofai/zo-sdk`](https://www.npmjs.com/package/@zofai/zo-sdk) | TypeScript SDK for ZLP / SLP / USDZ (reads + transaction builders) |

Current examples target **`@zofai/zo-sdk` ^0.2.x** (Pyth Pro / V3 market methods).

## Security

- Never commit `.env` or private keys. `trading-bot/.env` is gitignored.
- Prefer a dedicated bot wallet with only the funds you intend to trade.
- Test on **testnet** (`NETWORK=testnet`) before mainnet.
