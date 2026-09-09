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
   - Builds a gRPC Sui client via zo-sdk `createSuiProvider` (or `SUI_*_RPC_URL` as gRPC `baseUrl`).
   - Uses **@zofai/zo-sdk** `SDK.getInstance()` to create typed API/DataAPI instances for ZLP, SLP, and USDZ.
   - ZO API: `https://api.zofinance.io`. Hermes / Pyth Pro: `https://api.zofinance.io`.

2. **Keypair** (`keypair.ts`)
   - Loads `PRIVATE_KEY` from env and creates an `Ed25519Keypair` via `decodeSuiPrivateKey` + `Ed25519Keypair.fromSecretKey`.
   - Used for signing all Sui transactions (opens/closes positions, places/cancels orders).

3. **Bot trader verification** (`bot-trader.ts`)
   - Before any trading loop starts, calls ZO API `POST /bot-traders/challenge`, signs the exact `data.message` with `signPersonalMessage`, then `POST /bot-traders/verify`.
   - Skips signing if `alreadyVerified` or `GET /bot-traders/:address` reports `verified: true`.
   - Challenge expires in 10 minutes.

4. **Trade config**
   - You choose pool (`LPToken.ZLP`, `LPToken.SLP`, or `LPToken.USDZ`), index token (e.g. `btc`), collateral (e.g. `nusdc`), sizes, and (for TPSL) take-profit/stop-loss percentages.

5. **Trading methods (Pyth Pro / V3)**
   - Opens use `openPositionV3`; closes and TP/SL use `decreasePositionV3`.
   - Add collateral with `pledgeInPosition` (no oracle). Withdraw collateral with `redeemFromPositionV3` (SLP) or `redeemFromPositionV2` (ZLP / USDZ) plus Pyth Pro bytes.
   - Helpers: `pledgeInOpenPosition` / `redeemFromOpenPosition` in `trade.ts`.
   - Before each trade, call `api.fetchPythProUpdateBytesForTokens([collateral, index])` and pass the bytes into the V3 method.
   - Live account state uses ZO API `/trader-positions` and `/open-orders` only (no RPC `getPositionInfoList` hydrate, which 404s on leftover caps).
   - Reference prices use `getLatestPythProPricesForTokens` (Pyth Pro), with Binance as fallback.

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
| `connection.ts` | Shared gRPC Sui client and ZO SDK API (`createAPI` + `NETWORK`). |
| `keypair.ts` | Loads `PRIVATE_KEY` from env and returns Ed25519 keypair. |
| `bot-trader.ts` | ZO API bot-trader challenge / personal-message verify gate. |
| `network.ts` | Reads `NETWORK` from env (mainnet/testnet). |
| `order.ts` | Order caps and order key parsing. |
| `position.ts` | Position helpers. |
| `utils.ts` | Relayer fee, reserve amount, coin helpers. |
| `constants.ts` | Slippage, relayer fee, trade-level constants. |
| `deployments.ts` | `getConsts(NETWORK, pool)` for pool-specific contract addresses. |

### Dependencies

- **@zofai/zo-sdk** (`^0.3.17`) – ZO protocol API and types (pools, positions, orders; Pyth Pro V3 trading; gRPC Sui client).
- **@mysten/sui** (`^2.4.0`) – Sui keypair and transactions (zo-sdk 0.3.x uses `SuiGrpcClient`).
- **dotenv** – Loads `.env` into `process.env`.
- **bignumber.js** – Numeric handling for sizes and fees.

---

## Security

- **Never commit `.env`** or any file containing `PRIVATE_KEY`. `.env` is listed in `.gitignore`.
- Prefer a dedicated wallet for the bot with only the funds you are willing to trade.
- Use testnet first (`NETWORK=testnet`) to verify behavior before mainnet.
