# ZO Trading Bot

Example bot that trades on [ZO Finance](https://zofai.io) using the **zo-sdk**. Supports market orders with take-profit/stop-loss (TPSL), and a grid bot.

## Prerequisites

- **Node.js** (v18+)
- **pnpm** (or npm)
- A **Sui wallet** with a private key you can export (for automated signing)
- **SUI** on the target network (mainnet/testnet) for gas and trading

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Copy the example env file and set your secrets (never commit `.env`):

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `NETWORK` | No | `mainnet` or `testnet`. Default: `mainnet`. |
| `SUI_MAINNET_RPC_URL` | No | Sui mainnet RPC. Default: public fullnode. |
| `SUI_TESTNET_RPC_URL` | No | Sui testnet RPC. Default: public fullnode. |
| `PRIVATE_KEY` | **Yes** | Sui private key in **Bech32** format (e.g. `suiprivkey1...`). Used to sign transactions. |

**Getting your Bech32 private key**

- From **Sui CLI**: export the key for your key identity (Bech32 is one of the supported formats).
- From **Sui wallet**: use the wallet’s export feature if it supports Bech32; otherwise you may need to convert.

The app uses `decodeSuiPrivateKey(privateKeyBech32)` from `@mysten/sui/cryptography`, so the key must be in a format that function accepts (e.g. Bech32 `suiprivkey1...`).

### 3. Run the bot

**Market / TPSL bot** (entry point: `index.ts`):

```bash
pnpm start
```

**Grid bot** (entry point: `grid-bot-run.ts`):

```bash
pnpm run grid
```

Before running, edit the config in the corresponding file (see below).

---

## Integration overview

### How the bot connects to ZO

1. **Connection** (`connection.ts`)
   - Builds a `SuiClient` from `SUI_MAINNET_RPC_URL` or `SUI_TESTNET_RPC_URL` and `NETWORK`.
   - Uses **zo-sdk** `SDKFactory` to create API and DataAPI instances for ZLP, SLP, and USDZ pools.
   - ZO API endpoint: `https://api.zofinance.io`. Pyth price connection: `https://hermes.pyth.network`.

2. **Keypair** (`keypair.ts`)
   - Loads `PRIVATE_KEY` from env and creates an `Ed25519Keypair` via `decodeSuiPrivateKey` + `Ed25519Keypair.fromSecretKey`.
   - Used for signing all Sui transactions (opens/closes positions, places/cancels orders).

3. **Trade config**
   - You choose pool (`LPToken.ZLP`, `LPToken.SLP`, or `LPToken.USDZ`), index token (e.g. `btc`), collateral (e.g. `nusdc`), sizes, and (for TPSL) take-profit/stop-loss percentages.

### Config for market / TPSL bot

Edit `index.ts` and set `TradeConfig` (and optionally switch between `tradeWithMarketOrder` and `tradeWithTPSL`):

- `indexToken`, `collateralToken`, `pool`, `long`
- `minSize` / `maxSize` (in index token base units, e.g. 1e8 for BTC) or fixed `size`
- `collateralAmount` (in collateral base units, e.g. 6 decimals for USDC)
- `takeProfitPercentage`, `stopLossPercentage`
- `tradeInterval` (ms), `tradeMode`: `'Market'` or `'TPSL'`
- `createOpposite`: whether to open the opposite position after closing.

### Config for grid bot

Edit `grid-bot-run.ts` and set the grid config object:

- `indexToken`, `collateralToken`, `pool`
- `gridLowerPrice`, `gridUpperPrice`, `gridLevels`
- `orderSize` (index token base units), `collateralAmount` (collateral base units)
- `pollIntervalMs`, optional `maxVolumeUSD`

Then run:

```bash
pnpm run grid
```

### Project layout

| File | Purpose |
|------|--------|
| `index.ts` | Market / TPSL bot entry; defines `TradeConfig` and calls `tradeWithMarketOrder` or `tradeWithTPSL`. |
| `grid-bot-run.ts` | Grid bot entry; defines grid config and calls `runGridBot`. |
| `grid-bot.ts` | Grid bot logic (place/cancel orders, rebalance grid). |
| `trade.ts` | Core trading: open/close positions, TPSL and market flows. |
| `connection.ts` | Sui client and ZO SDK API/DataAPI instances (ZLP/SLP/USDZ). |
| `keypair.ts` | Loads `PRIVATE_KEY` from env and returns Ed25519 keypair. |
| `network.ts` | Reads `NETWORK` from env (mainnet/testnet). |
| `order.ts` | Order caps and order key parsing. |
| `position.ts` | Position helpers. |
| `utils.ts` | Relayer fee, reserve amount, coin helpers. |
| `constants.ts` | Slippage, relayer fee, trade-level constants. |
| `deployments.ts` | Uses `zo-sdk` `getConsts(NETWORK)` for contract addresses. |

### Dependencies

- **zo-sdk** – ZO protocol API and types (pools, positions, orders).
- **@mysten/sui** – Sui client, keypair, transactions.
- **dotenv** – Loads `.env` into `process.env`.
- **bignumber.js** – Numeric handling for sizes and fees.

---

## Security

- **Never commit `.env`** or any file containing `PRIVATE_KEY`. `.env` is listed in `.gitignore`.
- Prefer a dedicated wallet for the bot with only the funds you are willing to trade.
- Use testnet first (`NETWORK=testnet`) to verify behavior before mainnet.
