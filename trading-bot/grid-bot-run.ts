/**
 * Example runner for the grid bot. Edit the config below and run: pnpm run grid
 */
import dotenv from 'dotenv';
import { runGridBot } from './grid-bot';
import { LPToken } from 'zo-sdk';

dotenv.config();

const gridConfig = {
    indexToken: 'btc',
    collateralToken: 'nusdc',
    pool: LPToken.USDZ,
    gridLowerPrice: 66_000,
    gridUpperPrice: 70_000,
    gridLevels: 5,
    orderSize: BigInt(1_500_000), // 0.015 BTC in base units (8 decimals -> 1500000 = 0.015)
    collateralAmount: BigInt(50_000_000), // 50 USDC (6 decimals)
    pollIntervalMs: 30_000, // 30 seconds
    maxVolumeUSD: 1_000_000, // optional: stop after $1M volume
};

runGridBot(gridConfig).catch(console.error);
