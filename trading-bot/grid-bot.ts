/**
 * Grid trading bot: places orders at price levels and trades when price crosses levels.
 * Long grid: open long when price drops to a level, close long when price rises to the next level.
 */

import {
    getConnection,
    getZLPAPIInstance,
    getZLPDataAPIInstance,
    getSLPAPIInstance,
    getSLPDataAPIInstance,
    getUSDZAPIInstance,
    getUSDZDataAPIInstance,
} from './connection';
import { getKeypair } from './keypair';
import {
    calculateRelayerFeeInToken,
    calculateReserveAmount,
    GetAllCoin,
} from './utils';
import { DEFAULT_SLIPPAGE } from './constants';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import BigNumber from 'bignumber.js';
import { deployments } from './deployments';
import { IBaseAPI, LPToken } from '@zofai/zo-sdk';
import type { IBaseDataAPI } from '@zofai/zo-sdk';
import type { IBasePositionInfo } from '@zofai/zo-sdk';

export interface GridBotConfig {
    indexToken: string;
    collateralToken: string;
    pool: LPToken;
    /** Lower bound of grid (price) */
    gridLowerPrice: number;
    /** Upper bound of grid (price) */
    gridUpperPrice: number;
    /** Number of grid levels (price bands) */
    gridLevels: number;
    /** Size per grid order (in index token base units, e.g. 1e8 for BTC) */
    orderSize: bigint;
    collateralAmount: bigint;
    reserveAmount?: bigint; // Optional: if not set or 0, calculated from leverage
    /** Poll interval in ms */
    pollIntervalMs: number;
    /** Optional max total volume in USD before stopping */
    maxVolumeUSD?: number;
}

async function fetchPrice(token: string): Promise<number> {
    const parsedToken = token === 'nusdc' ? 'usdc' : token;
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${parsedToken.toUpperCase()}USDT`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch price for ${token}: HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data?.price) {
        throw new Error(`Invalid response from Binance API for ${token}`);
    }
    const price = parseFloat(data.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price value for ${token}: ${data.price}`);
    }
    return price;
}

/** Build grid level prices (linear spacing) */
function buildGridPrices(lower: number, upper: number, levels: number): number[] {
    if (levels < 2) return [lower, upper];
    const step = (upper - lower) / (levels - 1);
    const prices: number[] = [];
    for (let i = 0; i < levels; i++) {
        prices.push(lower + step * i);
    }
    return prices;
}

/** Get grid level index for current price (0 = at/below lowest, levels-1 = at/above highest) */
function getGridLevelIndex(price: number, gridPrices: number[]): number {
    if (price <= gridPrices[0]) return 0;
    if (price >= gridPrices[gridPrices.length - 1]) return gridPrices.length - 1;
    for (let i = gridPrices.length - 1; i >= 0; i--) {
        if (price >= gridPrices[i]) return i;
    }
    return 0;
}

function getAPIAndDataAPI(pool: LPToken): { api: IBaseAPI; dataAPI: IBaseDataAPI } {
    switch (pool) {
        case LPToken.ZLP:
            return { api: getZLPAPIInstance(), dataAPI: getZLPDataAPIInstance() };
        case LPToken.SLP:
            return { api: getSLPAPIInstance(), dataAPI: getSLPDataAPIInstance() };
        case LPToken.USDZ:
            return { api: getUSDZAPIInstance(), dataAPI: getUSDZDataAPIInstance() };
        default:
            return { api: getZLPAPIInstance(), dataAPI: getZLPDataAPIInstance() };
    }
}

let totalTradedVolumeUSD = 0;

export async function runGridBot(config: GridBotConfig): Promise<void> {
    const client = getConnection();
    const keypair = getKeypair();
    const userAddress = keypair.getPublicKey().toSuiAddress();
    const { api, dataAPI } = getAPIAndDataAPI(config.pool);
    const coinType = deployments.coins[config.collateralToken].module;
    const gridPrices = buildGridPrices(
        config.gridLowerPrice,
        config.gridUpperPrice,
        config.gridLevels,
    );

    let lastGridIndex: number | null = null;
    const maxVolume = config.maxVolumeUSD ?? Infinity;

    console.log('Grid bot started');
    console.log(`Grid: ${config.gridLowerPrice} - ${config.gridUpperPrice}, ${config.gridLevels} levels`);
    console.log(`Levels: ${gridPrices.map((p) => p.toFixed(2)).join(', ')}`);

    const openLongPosition = async (): Promise<boolean> => {
        const indexPrice = await fetchPrice(config.indexToken);
        const collateralPrice = await fetchPrice(config.collateralToken);
        const relayerFeeInToken = calculateRelayerFeeInToken(collateralPrice);
        const relayerFeeAmount = BigInt(
            BigNumber(relayerFeeInToken)
                .times(10 ** deployments.coins[config.collateralToken].decimals)
                .toFixed(0),
        );
        const coinObjects = await GetAllCoin(client, userAddress, coinType);
        let reserveAmount = config.reserveAmount ?? BigInt(0);
        if (reserveAmount === BigInt(0)) {
            const positionConfig = await dataAPI.getPositionConfig(
                config.indexToken,
                true,
            );
            reserveAmount = calculateReserveAmount(
                config.orderSize,
                config.collateralAmount,
                indexPrice,
                collateralPrice,
                deployments.coins[config.indexToken].decimals,
                deployments.coins[config.collateralToken].decimals,
                positionConfig.maxReservedMultiplier,
            );
        }
        const tx = await api.openPositionV2!(
            config.collateralToken,
            config.indexToken,
            config.orderSize,
            config.collateralAmount,
            coinObjects.map((c) => c.coinObjectId),
            true, // long
            reserveAmount,
            indexPrice,
            collateralPrice,
            false,
            false,
            DEFAULT_SLIPPAGE,
            DEFAULT_SLIPPAGE,
            relayerFeeAmount,
            '',
            userAddress,
            false,
            [],
        );
        tx.setSender(userAddress);
        tx.setGasBudget(1e9);
        const res = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
        if (res?.digest) {
            const sizeUSD =
                (Number(config.orderSize) * indexPrice) /
                10 ** deployments.coins[config.indexToken].decimals;
            totalTradedVolumeUSD += sizeUSD;
            console.log(`Grid: opened LONG, tx ${res.digest}, volume $${sizeUSD.toFixed(2)}`);
            return true;
        }
        return false;
    };

    const closeOneLongPosition = async (position: IBasePositionInfo): Promise<boolean> => {
        const indexPrice = await fetchPrice(config.indexToken);
        const collateralPrice = await fetchPrice(config.collateralToken);
        const relayerFeeInToken = calculateRelayerFeeInToken(collateralPrice);
        const relayerFeeAmount = BigInt(
            BigNumber(relayerFeeInToken)
                .times(10 ** deployments.coins[config.collateralToken].decimals)
                .toFixed(0),
        );
        const amount = BigInt(position.positionAmount);
        const coins = await GetAllCoin(client, userAddress, coinType);
        const tx = await api.decreasePositionV2!(
            position.id,
            config.collateralToken,
            config.indexToken,
            amount,
            true,
            indexPrice,
            collateralPrice,
            false,
            false,
            false,
            DEFAULT_SLIPPAGE,
            DEFAULT_SLIPPAGE,
            relayerFeeAmount,
            coins.map((c) => c.coinObjectId),
        );
        tx.setSender(userAddress);
        tx.setGasBudget(1e9);
        const res = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
        if (res?.digest) {
            const sizeUSD = Number(position.positionSize);
            totalTradedVolumeUSD += sizeUSD;
            console.log(`Grid: closed LONG position ${position.id}, tx ${res.digest}, volume $${sizeUSD.toFixed(2)}`);
            return true;
        }
        return false;
    };

    const runOnce = async (): Promise<void> => {
        if (totalTradedVolumeUSD >= maxVolume) {
            console.log(`Grid bot: max volume $${maxVolume} reached. Stopping.`);
            process.exit(0);
            return;
        }

        const indexPrice = await fetchPrice(config.indexToken);
        const currentLevel = getGridLevelIndex(indexPrice, gridPrices);

        if (lastGridIndex === null) {
            lastGridIndex = currentLevel;
            console.log(`Grid: initial level ${currentLevel}, price ${indexPrice.toFixed(4)}`);
            return;
        }

        const positionCaps = await dataAPI.getPositionCapInfoList(userAddress);
        const allPositions = await dataAPI.getPositionInfoList(positionCaps, userAddress);
        const openLongs = allPositions.filter(
            (p) =>
                p.indexToken === config.indexToken &&
                p.long &&
                !p.closed,
        );

        if (currentLevel < lastGridIndex) {
            // Price moved down: add a long (open one new position)
            console.log(`Grid: price down level ${lastGridIndex} -> ${currentLevel}, opening LONG`);
            const ok = await openLongPosition();
            if (ok) lastGridIndex = currentLevel;
        } else if (currentLevel > lastGridIndex) {
            // Price moved up: remove one long (close one position per level)
            if (openLongs.length === 0) {
                console.log(`Grid: price up but no long positions to close; syncing level ${lastGridIndex} -> ${currentLevel}`);
                lastGridIndex = currentLevel;
                return;
            }
            const toClose = openLongs[0];
            console.log(`Grid: price up level ${lastGridIndex} -> ${currentLevel}, closing one LONG`);
            const ok = await closeOneLongPosition(toClose);
            if (ok) lastGridIndex = lastGridIndex + 1; // advance one level per close so we catch up over multiple polls
        }
        // else currentLevel === lastGridIndex: no action
    };

    // Initial run then interval
    await runOnce();
    setInterval(runOnce, config.pollIntervalMs);
}
