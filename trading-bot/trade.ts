import {
    getZLPAPIInstance,
    getConnection,
    getZLPDataAPIInstance,
    getSLPAPIInstance,
    getSLPDataAPIInstance,
    getUSDZAPIInstance,
    getUSDZDataAPIInstance,
} from './connection';
import { getKeypair } from './keypair';
import { getPositionCaps } from './position';
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
import { Transaction } from '@mysten/sui/transactions';
import { IBaseAPI, LPToken } from '@zofai/zo-sdk';

export interface TradeConfig {
    indexToken: string;
    collateralToken: string;
    pool: LPToken;
    long: boolean;
    size?: bigint; // Optional now, for backward compatibility
    minSize?: bigint; // Minimum size for random selection
    maxSize?: bigint; // Maximum size for random selection
    collateralAmount: bigint;
    reserveAmount?: bigint; // Optional: if not set or 0, calculated from leverage
    takeProfitPercentage: number; // Changed from takeProfitPrice to takeProfitPercentage
    stopLossPercentage: number; // Changed from stopLossPrice to stopLossPercentage
    tradeInterval: number;
    createOpposite?: boolean;
    tradeMode: 'TPSL' | 'Market';
    maxVolumeUSD?: number; // Add max volume parameter with default
}

let apiInstance = getZLPAPIInstance();
let dataAPIInstance = getZLPDataAPIInstance();

// Add a global volume counter
let totalTradedVolumeUSD = 0;
const DEFAULT_MAX_VOLUME_USD = 4000000; // 4 million USD

async function fetchPrice(token: string): Promise<number> {
    const parsedToken = token === 'nusdc' ? 'usdc' : token;
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${parsedToken.toUpperCase()}USDT`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch price for ${token}: HTTP ${response.status}`,
            );
        }
        const data = await response.json();
        if (!data || !data.price) {
            throw new Error(
                `Invalid response from Binance API for ${token}: missing price field`,
            );
        }
        const price = parseFloat(data.price);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(
                `Invalid price value for ${token}: ${data.price}`,
            );
        }
        return price;
    } catch (error) {
        console.error(`Error fetching price for ${token}:`, error);
        throw error;
    }
}

// Calculate take profit and stop loss prices based on current price and percentages
function calculateTPSLPrices(
    currentPrice: number,
    takeProfitPercentage: number,
    stopLossPercentage: number,
    isLong: boolean,
) {
    if (isLong) {
        // For long positions: TP is higher, SL is lower
        const takeProfitPrice = currentPrice * (1 + takeProfitPercentage / 100);
        const stopLossPrice = currentPrice * (1 - stopLossPercentage / 100);
        return { takeProfitPrice, stopLossPrice };
    } else {
        // For short positions: TP is lower, SL is higher
        const takeProfitPrice = currentPrice * (1 - takeProfitPercentage / 100);
        const stopLossPrice = currentPrice * (1 + stopLossPercentage / 100);
        return { takeProfitPrice, stopLossPrice };
    }
}

// Add a function to track volume
function trackTradeVolume(sizeUSD: number, config: TradeConfig): boolean {
    totalTradedVolumeUSD += sizeUSD;
    const maxVolume = config.maxVolumeUSD || DEFAULT_MAX_VOLUME_USD;

    console.log(
        `Total traded volume: $${totalTradedVolumeUSD.toLocaleString()} / $${maxVolume.toLocaleString()}`,
    );

    if (totalTradedVolumeUSD >= maxVolume) {
        console.log(
            `Maximum trading volume of $${maxVolume.toLocaleString()} reached. Stopping trading bot.`,
        );
        return false; // Signal to stop trading
    }

    return true; // Continue trading
}

// Add a function to track volume
function checkTradeVolumeBeforeTrade(config: TradeConfig): boolean {
    const maxVolume = config.maxVolumeUSD || DEFAULT_MAX_VOLUME_USD;

    console.log(
        `Total traded volume: $${totalTradedVolumeUSD.toLocaleString()} / $${maxVolume.toLocaleString()}`,
    );

    if (totalTradedVolumeUSD >= maxVolume) {
        console.log(
            `Maximum trading volume of $${maxVolume.toLocaleString()} reached. Stopping trading bot.`,
        );
        return false; // Signal to stop trading
    }

    return true; // Continue trading
}

// Helper function to calculate trade size based on config
function calculateTradeSize(config: TradeConfig): bigint {
    if (config.minSize && config.maxSize) {
        // Generate a random size between minSize and maxSize
        const minSizeNumber = Number(config.minSize);
        const maxSizeNumber = Number(config.maxSize);
        const randomSize =
            Math.floor(Math.random() * (maxSizeNumber - minSizeNumber + 1)) +
            minSizeNumber;
        const tradeSize = BigInt(randomSize);
        console.log(
            `Calculated random size: ${tradeSize} (between ${config.minSize} and ${config.maxSize})`,
        );
        return tradeSize;
    } else {
        // Fall back to fixed size
        const tradeSize = config.size || BigInt(0);
        console.log(`Calculated fixed size: ${tradeSize}`);
        return tradeSize;
    }
}

async function createPosition(
    config: TradeConfig,
    direction: boolean, // true for long, false for short
    indexPrice: number,
    collateralPrice: number,
    collateralTokenType: string,
    client: SuiClient,
    keypair: Ed25519Keypair,
    userAddress: string,
    apiInstance: IBaseAPI,
    dataAPIInstance: { getPositionConfig: (indexToken: string, long: boolean) => Promise<{ maxReservedMultiplier: number }> },
    overrideTradeSize?: bigint, // Optional override to ensure same size for opposite positions
) {
    try {
        console.log(
            `start open ${direction ? 'LONG' : 'SHORT'} position ${config.indexToken} with collateral ${config.collateralToken} and pool ${config.pool}...`,
        );

        // Validate prices are valid numbers
        if (
            !Number.isFinite(indexPrice) ||
            !Number.isFinite(collateralPrice) ||
            indexPrice <= 0 ||
            collateralPrice <= 0
        ) {
            throw new Error(
                `Invalid prices: indexPrice=${indexPrice}, collateralPrice=${collateralPrice}. Cannot create position.`,
            );
        }

        // Check if we should continue trading based on volume
        if (!checkTradeVolumeBeforeTrade(config)) {
            console.log('Stopping trading due to volume limit');
            process.exit(0);
        }

        // Determine the trade size based on config or use override
        const tradeSize =
            overrideTradeSize !== undefined
                ? overrideTradeSize
                : calculateTradeSize(config);

        if (overrideTradeSize !== undefined) {
            console.log(
                `Using override size: ${tradeSize} (to match opposite position)`,
            );
        }

        const coinObjects = await GetAllCoin(
            client,
            userAddress,
            collateralTokenType,
        );

        const relayerFeeInToken = calculateRelayerFeeInToken(collateralPrice);
        const relayerFeeAmount = BigInt(
            BigNumber(relayerFeeInToken)
                .times(10 ** deployments.coins[config.collateralToken].decimals)
                .toFixed(0),
        );

        let reserveAmount = config.reserveAmount ?? BigInt(0);
        if (reserveAmount === BigInt(0)) {
            const positionConfig = await dataAPIInstance.getPositionConfig(
                config.indexToken,
                direction,
            );
            reserveAmount = calculateReserveAmount(
                tradeSize,
                config.collateralAmount,
                indexPrice,
                collateralPrice,
                deployments.coins[config.indexToken].decimals,
                deployments.coins[config.collateralToken].decimals,
                positionConfig.maxReservedMultiplier,
            );
        }

        const tx = await apiInstance.openPositionV2!(
            config.collateralToken,
            config.indexToken,
            tradeSize,
            config.collateralAmount,
            coinObjects.map((c) => c.coinObjectId),
            direction,
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

        const dryRunResult = await client.dryRunTransactionBlock({
            transactionBlock: await tx.build({
                client,
            }),
        });
        if (dryRunResult.effects.status.status === 'failure') {
            console.error(
                'Failed to dry run transaction: ',
                dryRunResult.effects.status.error,
            );
            throw new Error(dryRunResult.effects.status.error);
        }

        const res = await client.signAndExecuteTransaction({
            transaction: tx,
            signer: keypair,
        });

        if (res) {
            console.log(
                `open ${direction ? 'LONG' : 'SHORT'} position success, transaction id: ${res?.digest}`,
            );

            // Calculate position size in USD
            const sizeUSD =
                (Number(tradeSize) * indexPrice) /
                10 ** deployments.coins[config.indexToken].decimals;

            // Check if we should continue trading based on volume
            if (!trackTradeVolume(sizeUSD, config)) {
                console.log('Stopping trading due to volume limit');
                process.exit(0);
            }

            await new Promise((resolve) => setTimeout(resolve, 5000));
            const updatedPositions = await getPositionCaps(client, userAddress);

            if (updatedPositions.length > 0) {
                // Find the position we just created
                const symbolToMatch = `${direction ? 'LONG' : 'SHORT'}`;
                const newPosition = updatedPositions.find(
                    (pos) =>
                        pos.key &&
                        pos.key.symbolKey.direction.includes(symbolToMatch) &&
                        pos.key.symbolKey.index.includes(config.indexToken),
                );

                if (newPosition) {
                    return true;
                }
            }
        }
        return false;
    } catch (error) {
        console.error(
            `Failed to create ${direction ? 'LONG' : 'SHORT'} position:`,
            error,
        );
        return false;
    }
}

// close position by position id
async function closePosition(
    client: SuiClient,
    signer: Ed25519Keypair,
    positionId: string,
    collateralToken: string,
    collateralTokenType: string,
    indexToken: string,
    amount: bigint,
    long: boolean,
    userAddress: string,
    config: TradeConfig,
    apiInstance: IBaseAPI,
) {
    try {
        // get current price as reference
        const indexPrice = await fetchPrice(indexToken);
        const collateralPrice = await fetchPrice(collateralToken);
        const relayerFeeInToken = calculateRelayerFeeInToken(collateralPrice);
        const relayerFeeAmount = BigInt(
            BigNumber(relayerFeeInToken)
                .times(10 ** deployments.coins[collateralToken].decimals)
                .toFixed(0),
        );

        console.log(`closing position ${positionId}, price: ${indexPrice}`);
        const coins = await GetAllCoin(
            client,
            userAddress,
            collateralTokenType,
        );

        const tx1 = await apiInstance.decreasePositionV2!(
            positionId,
            collateralToken,
            indexToken,
            amount,
            long,
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

        tx1.setSender(userAddress);
        tx1.setGasBudget(1e9);

        const dryRunResult = await client.dryRunTransactionBlock({
            transactionBlock: await tx1.build({
                client,
            }),
        });
        if (dryRunResult.effects.status.status === 'failure') {
            console.error(
                'Failed to dry run transaction: ',
                dryRunResult.effects.status.error,
            );
            const transaction = dryRunResult.input.transaction;
            if (
                transaction &&
                'kind' in transaction &&
                transaction.kind === 'ProgrammableTransaction'
            ) {
                // console.error('\n=== ALL TRANSACTIONS ===');
                // console.error(JSON.stringify(transaction.transactions, null, 2));
                console.error('\n=== INPUT 1 ===');
                console.error(JSON.stringify(transaction.inputs?.[1], null, 2));
                console.error('\n=== COMMAND 6 (where error occurred) ===');
                if (transaction.transactions[6]) {
                    console.error(
                        JSON.stringify(transaction.transactions[6], null, 2),
                    );
                }
            }
            throw new Error(dryRunResult.effects.status.error);
        }

        const res1 = await client.signAndExecuteTransaction({
            transaction: tx1,
            signer,
        });

        if (res1) {
            console.log(
                `closed position ${positionId}, transaction id: ${res1?.digest}`,
            );

            // Calculate position size in USD for volume tracking
            const sizeUSD =
                (Number(amount) * indexPrice) /
                10 ** deployments.coins[indexToken].decimals;

            // Track the volume
            if (!trackTradeVolume(sizeUSD, config)) {
                console.log('Stopping trading due to volume limit');
                process.exit(0);
                return false;
            }
            return true;
        }
        return false;
    } catch (error) {
        console.error('cannot close position:', error);
        return false;
    }
}

async function createPositionWithTPSLOrders(
    config: TradeConfig,
    direction: boolean, // true for long, false for short
    indexPrice: number,
    collateralPrice: number,
    collateralTokenType: string,
    client: SuiClient,
    keypair: Ed25519Keypair,
    userAddress: string,
    apiInstance: any,
    dataAPIInstance: { getPositionConfig: (indexToken: string, long: boolean) => Promise<{ maxReservedMultiplier: number }> },
    overrideTradeSize?: bigint, // Optional override to ensure same size for opposite positions
) {
    try {
        console.log(
            `start open ${direction ? 'LONG' : 'SHORT'} position ${config.indexToken}...`,
        );

        // Validate prices are valid numbers
        if (
            !Number.isFinite(indexPrice) ||
            !Number.isFinite(collateralPrice) ||
            indexPrice <= 0 ||
            collateralPrice <= 0
        ) {
            throw new Error(
                `Invalid prices: indexPrice=${indexPrice}, collateralPrice=${collateralPrice}. Cannot create position.`,
            );
        }

        // Check if we should continue trading based on volume
        if (!checkTradeVolumeBeforeTrade(config)) {
            console.log('Stopping trading due to volume limit');
            process.exit(0);
        }

        // Determine the trade size based on config or use override
        const tradeSize =
            overrideTradeSize !== undefined
                ? overrideTradeSize
                : calculateTradeSize(config);

        if (overrideTradeSize !== undefined) {
            console.log(
                `Using override size: ${tradeSize} (to match opposite position)`,
            );
        }

        const coinObjects = await GetAllCoin(
            client,
            userAddress,
            collateralTokenType,
        );
        const relayerFeeInToken = calculateRelayerFeeInToken(collateralPrice);
        const relayerFeeAmount = BigInt(
            BigNumber(relayerFeeInToken)
                .times(10 ** deployments.coins[config.collateralToken].decimals)
                .toFixed(0),
        );

        let reserveAmount = config.reserveAmount ?? BigInt(0);
        if (reserveAmount === BigInt(0)) {
            const positionConfig = await dataAPIInstance.getPositionConfig(
                config.indexToken,
                direction,
            );
            reserveAmount = calculateReserveAmount(
                tradeSize,
                config.collateralAmount,
                indexPrice,
                collateralPrice,
                deployments.coins[config.indexToken].decimals,
                deployments.coins[config.collateralToken].decimals,
                positionConfig.maxReservedMultiplier,
            );
        }

        const tx = await apiInstance.openPositionV2!(
            config.collateralToken,
            config.indexToken,
            tradeSize,
            config.collateralAmount,
            coinObjects.map((c) => c.coinObjectId),
            direction,
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
        );

        tx.setSender(userAddress);
        tx.setGasBudget(1e9);

        const dryRunResult = await client.dryRunTransactionBlock({
            transactionBlock: await tx.build({
                client,
            }),
        });
        if (dryRunResult.effects.status.status === 'failure') {
            console.error(
                'Failed to dry run transaction: ',
                dryRunResult.effects.status.error,
            );
            throw new Error(dryRunResult.effects.status.error);
        }

        const res = await client.signAndExecuteTransaction({
            transaction: tx,
            signer: keypair,
        });

        if (res) {
            console.log(
                `open ${direction ? 'LONG' : 'SHORT'} position success, transaction id: ${res?.digest}`,
            );

            // Calculate position size in USD
            const sizeUSD =
                (Number(tradeSize) * indexPrice) /
                10 ** deployments.coins[config.indexToken].decimals;

            // Check if we should continue trading based on volume
            if (!trackTradeVolume(sizeUSD, config)) {
                console.log('Stopping trading due to volume limit');
                process.exit(0);
            }

            await new Promise((resolve) => setTimeout(resolve, 5000));
            const updatedPositions = await getPositionCaps(client, userAddress);

            if (updatedPositions.length > 0) {
                // Find the position we just created
                const symbolToMatch = `${direction ? 'LONG' : 'SHORT'}`;
                const newPosition = updatedPositions.find(
                    (pos) =>
                        pos.key &&
                        pos.key.symbolKey.direction.includes(symbolToMatch) &&
                        pos.key.symbolKey.index.includes(config.indexToken),
                );

                if (newPosition) {
                    // Calculate TP/SL prices based on percentages and direction
                    const { takeProfitPrice, stopLossPrice } =
                        calculateTPSLPrices(
                            indexPrice,
                            config.takeProfitPercentage,
                            config.stopLossPercentage,
                            direction,
                        );

                    await createTPSLOrders(
                        client,
                        keypair,
                        newPosition.id,
                        config.collateralToken,
                        collateralTokenType,
                        config.indexToken,
                        tradeSize,
                        direction,
                        takeProfitPrice,
                        stopLossPrice,
                        userAddress,
                    );

                    return true;
                }
            }
        }
        return false;
    } catch (error) {
        console.error(
            `Failed to create ${direction ? 'LONG' : 'SHORT'} position:`,
            error,
        );
        return false;
    }
}

export async function tradeWithTPSL(config: TradeConfig) {
    try {
        console.log('Starting...');
        const client = getConnection();
        const keypair = getKeypair();
        const userAddress = keypair.getPublicKey().toSuiAddress();

        console.log(`Using address: ${userAddress}`);
        console.log(
            `Trade config: ${config.long ? 'LONG' : 'SHORT'} ${config.indexToken}, collateral: ${config.collateralToken}`,
        );
        console.log(
            `TP/SL percentages: TP=${config.takeProfitPercentage}%, SL=${config.stopLossPercentage}%`,
        );
        if (config.createOpposite) {
            console.log(`Will also create opposite position for hedging`);
        }

        // Add volume limit logging
        const maxVolume = config.maxVolumeUSD || DEFAULT_MAX_VOLUME_USD;
        console.log(`Volume limit: $${maxVolume.toLocaleString()}`);
        console.log(
            `Current total volume: $${totalTradedVolumeUSD.toLocaleString()}`,
        );

        switch (config.pool) {
            case LPToken.ZLP: {
                apiInstance = getZLPAPIInstance();
                dataAPIInstance = getZLPDataAPIInstance();
                break;
            }
            case LPToken.SLP: {
                apiInstance = getSLPAPIInstance();
                dataAPIInstance = getSLPDataAPIInstance();
                break;
            }
            case LPToken.USDZ: {
                apiInstance = getUSDZAPIInstance();
                dataAPIInstance = getUSDZDataAPIInstance();
                break;
            }
            default: {
                apiInstance = getZLPAPIInstance();
                dataAPIInstance = getZLPDataAPIInstance();
            }
        }

        let isTrading = false;
        let shouldContinueTrading = true;

        // Define the trading logic as a reusable function
        let intervalId: NodeJS.Timeout;
        const executeTradingLogic = async () => {
            // Check if we should stop trading due to volume limit
            if (!shouldContinueTrading) {
                console.log('Stopping trading interval due to volume limit');
                if (intervalId) clearInterval(intervalId);
                process.exit(0);
                return;
            }

            if (isTrading) return;
            isTrading = true;

            try {
                const maxVolume = config.maxVolumeUSD || DEFAULT_MAX_VOLUME_USD;
                const remainingVolume = maxVolume - totalTradedVolumeUSD;

                if (remainingVolume <= 0) {
                    console.log(
                        `Volume limit of $${maxVolume.toLocaleString()} reached. Stopping trading bot.`,
                    );
                    shouldContinueTrading = false;
                    isTrading = false;
                    return;
                }

                const indexPrice = await fetchPrice(config.indexToken);
                const collateralPrice = await fetchPrice(
                    config.collateralToken,
                );

                console.log(
                    `current price: ${config.indexToken} = ${indexPrice}, ${config.collateralToken} = ${collateralPrice}`,
                );

                // Calculate TP/SL prices for both long and short positions
                const longPrices = calculateTPSLPrices(
                    indexPrice,
                    config.takeProfitPercentage,
                    config.stopLossPercentage,
                    true,
                );
                const shortPrices = calculateTPSLPrices(
                    indexPrice,
                    config.takeProfitPercentage,
                    config.stopLossPercentage,
                    false,
                );

                console.log(
                    `TP/SL for LONG: TP=${longPrices.takeProfitPrice.toFixed(4)}, SL=${longPrices.stopLossPrice.toFixed(4)}`,
                );
                console.log(
                    `TP/SL for SHORT: TP=${shortPrices.takeProfitPrice.toFixed(4)}, SL=${shortPrices.stopLossPrice.toFixed(4)}`,
                );

                const positionCaps =
                    await dataAPIInstance.getPositionCapInfoList(userAddress);
                const orderCaps =
                    await dataAPIInstance.getOrderCapInfoList(userAddress);

                // Get all position info (both open and closed)
                const allPositions = await dataAPIInstance.getPositionInfoList(
                    positionCaps,
                    userAddress,
                );

                // Get position info and filter closed positions
                const positions = allPositions.filter((ps) => !ps.closed);

                // Get closed positions for our token
                const closedPositions = allPositions.filter(
                    (ps) => ps.closed && ps.indexToken === config.indexToken,
                );

                // Get all orders
                const orders = await dataAPIInstance.getOrderInfoList(
                    orderCaps,
                    userAddress,
                );

                // Get executed orders
                const executedOrders = orders.filter((order) => order.executed);

                console.log(`positions: ${positions.length}`);
                console.log(`orders: ${orders.length}`);

                // Track if positions were closed (before clearing)
                const positionsWereClosed = closedPositions.length > 0;

                // Clear closed positions and executed orders
                await clearPositionsAndOrders(
                    client,
                    keypair,
                    closedPositions,
                    executedOrders,
                    userAddress,
                );

                const hasLongPosition = positions.some(
                    (pos) =>
                        pos.indexToken === config.indexToken &&
                        pos.long &&
                        !pos.closed,
                );

                const hasShortPosition = positions.some(
                    (pos) =>
                        pos.indexToken === config.indexToken &&
                        !pos.long &&
                        !pos.closed,
                );

                // Ensure we have enough coins by splitting if necessary
                const coinType =
                    deployments.coins[config.collateralToken].module;

                // Get the size from existing primary position if it exists, otherwise calculate it
                let primaryTradeSize: bigint | undefined = undefined;
                if (config.long && hasLongPosition) {
                    // Get size from existing long position
                    const existingPosition = positions.find(
                        (pos) =>
                            pos.indexToken === config.indexToken &&
                            pos.long &&
                            !pos.closed,
                    );
                    if (existingPosition) {
                        primaryTradeSize = BigInt(
                            existingPosition.positionAmount.toString(),
                        );
                        console.log(
                            `Using existing LONG position size: ${primaryTradeSize}`,
                        );
                    }
                } else if (!config.long && hasShortPosition) {
                    // Get size from existing short position
                    const existingPosition = positions.find(
                        (pos) =>
                            pos.indexToken === config.indexToken &&
                            !pos.long &&
                            !pos.closed,
                    );
                    if (existingPosition) {
                        primaryTradeSize = BigInt(
                            existingPosition.positionAmount.toString(),
                        );
                        console.log(
                            `Using existing SHORT position size: ${primaryTradeSize}`,
                        );
                    }
                }

                // If positions were closed, immediately create new ones without waiting for interval
                if (positionsWereClosed) {
                    console.log(
                        'Positions were closed (via TP/SL orders), immediately checking for new positions to create...',
                    );
                    // Wait a bit for the blockchain to update
                    await new Promise((resolve) => setTimeout(resolve, 2000));

                    // Refresh position data after closing
                    const updatedPositionCaps =
                        await dataAPIInstance.getPositionCapInfoList(
                            userAddress,
                        );
                    const updatedPositions = (
                        await dataAPIInstance.getPositionInfoList(
                            updatedPositionCaps,
                            userAddress,
                        )
                    ).filter((ps) => !ps.closed);

                    // Get fresh prices
                    const freshIndexPrice = await fetchPrice(config.indexToken);
                    const freshCollateralPrice = await fetchPrice(
                        config.collateralToken,
                    );

                    // Create positions immediately
                    const updatedHasLongPosition = updatedPositions.some(
                        (pos) =>
                            pos.indexToken === config.indexToken &&
                            pos.long &&
                            !pos.closed,
                    );
                    const updatedHasShortPosition = updatedPositions.some(
                        (pos) =>
                            pos.indexToken === config.indexToken &&
                            !pos.long &&
                            !pos.closed,
                    );

                    // Get the size from existing primary position if it exists
                    let updatedPrimaryTradeSize: bigint | undefined = undefined;
                    if (config.long && updatedHasLongPosition) {
                        const existingPosition = updatedPositions.find(
                            (pos) =>
                                pos.indexToken === config.indexToken &&
                                pos.long &&
                                !pos.closed,
                        );
                        if (existingPosition) {
                            updatedPrimaryTradeSize = BigInt(
                                existingPosition.positionAmount.toString(),
                            );
                        }
                    } else if (!config.long && updatedHasShortPosition) {
                        const existingPosition = updatedPositions.find(
                            (pos) =>
                                pos.indexToken === config.indexToken &&
                                !pos.long &&
                                !pos.closed,
                        );
                        if (existingPosition) {
                            updatedPrimaryTradeSize = BigInt(
                                existingPosition.positionAmount.toString(),
                            );
                        }
                    }

                    // Check if we need to create the primary position
                    if (!updatedHasLongPosition && config.long) {
                        updatedPrimaryTradeSize = calculateTradeSize(config);
                        await createPositionWithTPSLOrders(
                            config,
                            true, // long
                            freshIndexPrice,
                            freshCollateralPrice,
                            coinType,
                            client,
                            keypair,
                            userAddress,
                            apiInstance,
                            dataAPIInstance,
                            updatedPrimaryTradeSize,
                        );
                    } else if (!updatedHasShortPosition && !config.long) {
                        updatedPrimaryTradeSize = calculateTradeSize(config);
                        await createPositionWithTPSLOrders(
                            config,
                            false, // short
                            freshIndexPrice,
                            freshCollateralPrice,
                            coinType,
                            client,
                            keypair,
                            userAddress,
                            apiInstance,
                            dataAPIInstance,
                            updatedPrimaryTradeSize,
                        );
                    }

                    // Check if we need to create the opposite position for hedging
                    if (config.createOpposite) {
                        if (!updatedHasLongPosition && !config.long) {
                            const oppositeSize =
                                updatedPrimaryTradeSize !== undefined
                                    ? updatedPrimaryTradeSize
                                    : calculateTradeSize(config);
                            await createPositionWithTPSLOrders(
                                config,
                                true, // long
                                freshIndexPrice,
                                freshCollateralPrice,
                                coinType,
                                client,
                                keypair,
                                userAddress,
                                apiInstance,
                                dataAPIInstance,
                                oppositeSize,
                            );
                        } else if (!updatedHasShortPosition && config.long) {
                            const oppositeSize =
                                updatedPrimaryTradeSize !== undefined
                                    ? updatedPrimaryTradeSize
                                    : calculateTradeSize(config);
                            await createPositionWithTPSLOrders(
                                config,
                                false, // short
                                freshIndexPrice,
                                freshCollateralPrice,
                                coinType,
                                client,
                                keypair,
                                userAddress,
                                apiInstance,
                                dataAPIInstance,
                                oppositeSize,
                            );
                        }
                    }
                } else {
                    // No positions were closed, proceed with normal logic
                    // Check if we need to create the primary position
                    if (!hasLongPosition && config.long) {
                        primaryTradeSize = calculateTradeSize(config);
                        await createPositionWithTPSLOrders(
                            config,
                            true, // long
                            indexPrice,
                            collateralPrice,
                            coinType,
                            client,
                            keypair,
                            userAddress,
                            apiInstance,
                            dataAPIInstance,
                            primaryTradeSize,
                        );
                    } else if (!hasShortPosition && !config.long) {
                        primaryTradeSize = calculateTradeSize(config);
                        await createPositionWithTPSLOrders(
                            config,
                            false, // short
                            indexPrice,
                            collateralPrice,
                            coinType,
                            client,
                            keypair,
                            userAddress,
                            apiInstance,
                            dataAPIInstance,
                            primaryTradeSize,
                        );
                    }

                    // Check if we need to create the opposite position for hedging
                    if (config.createOpposite) {
                        if (!hasLongPosition && !config.long) {
                            // Create opposite long position if main is short
                            // Use the same size as the primary position
                            const oppositeSize =
                                primaryTradeSize !== undefined
                                    ? primaryTradeSize
                                    : calculateTradeSize(config);
                            await createPositionWithTPSLOrders(
                                config,
                                true, // long
                                indexPrice,
                                collateralPrice,
                                coinType,
                                client,
                                keypair,
                                userAddress,
                                apiInstance,
                                dataAPIInstance,
                                oppositeSize,
                            );
                        } else if (!hasShortPosition && config.long) {
                            // Create opposite short position if main is long
                            // Use the same size as the primary position
                            const oppositeSize =
                                primaryTradeSize !== undefined
                                    ? primaryTradeSize
                                    : calculateTradeSize(config);
                            await createPositionWithTPSLOrders(
                                config,
                                false, // short
                                indexPrice,
                                collateralPrice,
                                coinType,
                                client,
                                keypair,
                                userAddress,
                                apiInstance,
                                dataAPIInstance,
                                oppositeSize,
                            );
                        }
                    }
                }

                // Check for existing positions that need TP/SL orders
                for (const position of positions) {
                    if (position.closed) continue;

                    const isLong = position.long;
                    const isForToken =
                        position.indexToken === config.indexToken;
                    if (!isForToken) continue;

                    const hasTPOrder = orders.some((order) => {
                        return (
                            !order.executed &&
                            order.long === isLong &&
                            order.indexToken === config.indexToken &&
                            order.decreaseOrder &&
                            order.decreaseOrder.takeProfit
                        );
                    });

                    const hasSLOrder = orders.some((order) => {
                        return (
                            !order.executed &&
                            order.long === isLong &&
                            order.indexToken === config.indexToken &&
                            order.decreaseOrder &&
                            !order.decreaseOrder.takeProfit
                        );
                    });

                    if (!hasTPOrder || !hasSLOrder) {
                        console.log(
                            `create take profit/stop loss order for existing ${isLong ? 'LONG' : 'SHORT'} position...`,
                        );

                        // Calculate TP/SL prices based on percentages and position direction
                        const { takeProfitPrice, stopLossPrice } =
                            calculateTPSLPrices(
                                indexPrice,
                                config.takeProfitPercentage,
                                config.stopLossPercentage,
                                isLong,
                            );

                        await createTPSLOrders(
                            client,
                            keypair,
                            position.id,
                            config.collateralToken,
                            coinType,
                            config.indexToken,
                            BigInt(position.positionSize),
                            isLong,
                            takeProfitPrice,
                            stopLossPrice,
                            userAddress,
                            hasTPOrder,
                            hasSLOrder,
                        );
                    }
                }
            } catch (error) {
                console.error('trade bot execution error:', error);
            } finally {
                isTrading = false;
            }
        };

        // Execute immediately without waiting for the first interval
        executeTradingLogic();

        // Then set up the interval for subsequent executions
        intervalId = setInterval(executeTradingLogic, config.tradeInterval);
    } catch (error) {
        console.error('trade bot initialization failed:', error);
        process.exit(1);
    }
}

// create take profit/stop loss order function
async function createTPSLOrders(
    client: SuiClient,
    signer: Ed25519Keypair,
    positionId: string,
    collateralToken: string,
    collateralTokenType: string,
    indexToken: string,
    amount: bigint,
    long: boolean,
    takeProfitPrice: number,
    stopLossPrice: number,
    userAddress: string,
    hasTP?: boolean,
    hasSL?: boolean,
) {
    try {
        // get current price as reference
        const indexPrice = await fetchPrice(indexToken);
        const collateralPrice = await fetchPrice(collateralToken);
        const relayerFeeInToken = calculateRelayerFeeInToken(collateralPrice);
        const relayerFeeAmount = BigInt(
            BigNumber(relayerFeeInToken)
                .times(10 ** deployments.coins[collateralToken].decimals)
                .toFixed(0),
        );

        if (!hasTP) {
            console.log(
                `create take profit order for position ${positionId}, price: ${takeProfitPrice}, relayer fee: ${relayerFeeAmount}`,
            );
            const coins = await GetAllCoin(
                client,
                userAddress,
                collateralTokenType,
            );

            const tx1 = await apiInstance.decreasePositionV2!(
                positionId,
                collateralToken,
                indexToken,
                amount,
                long,
                takeProfitPrice,
                collateralPrice,
                true,
                true,
                false,
                DEFAULT_SLIPPAGE,
                DEFAULT_SLIPPAGE,
                relayerFeeAmount,
                coins.map((c) => c.coinObjectId),
            );

            tx1.setSender(userAddress);
            tx1.setGasBudget(1e9);

            const dryRunResult = await client.dryRunTransactionBlock({
                transactionBlock: await tx1.build({
                    client,
                }),
            });
            if (dryRunResult.effects.status.status === 'failure') {
                console.error(
                    'Failed to dry run transaction: ',
                    dryRunResult.effects.status.error,
                );
                throw new Error(dryRunResult.effects.status.error);
            }

            const res1 = await client.signAndExecuteTransaction({
                transaction: tx1,
                signer,
            });

            if (res1) {
                console.log(
                    `create take profit order success, transaction id: ${res1?.digest}`,
                );
            }

            // wait 2 seconds
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (!hasSL) {
            console.log(
                `create stop loss order for position ${positionId}, price: ${stopLossPrice}`,
            );

            const coins = await GetAllCoin(
                client,
                userAddress,
                collateralTokenType,
            );
            const tx2 = await apiInstance.decreasePositionV2!(
                positionId,
                collateralToken,
                indexToken,
                amount,
                long,
                stopLossPrice,
                collateralPrice,
                true,
                false,
                false,
                DEFAULT_SLIPPAGE,
                DEFAULT_SLIPPAGE,
                relayerFeeAmount,
                coins.map((c) => c.coinObjectId),
            );

            tx2.setSender(userAddress);
            tx2.setGasBudget(1e9);

            const dryRunResult = await client.dryRunTransactionBlock({
                transactionBlock: await tx2.build({
                    client,
                }),
            });
            if (dryRunResult.effects.status.status === 'failure') {
                console.error(
                    'Failed to dry run transaction: ',
                    dryRunResult.effects.status.error,
                );
                throw new Error(dryRunResult.effects.status.error);
            }

            const res2 = await client.signAndExecuteTransaction({
                transaction: tx2,
                signer,
            });

            if (res2) {
                console.log(
                    `create stop loss order success, transaction id: ${res2?.digest}`,
                );
            }
        }
    } catch (error) {
        console.error('create take profit/stop loss order failed:', error);
    }
}

// Helper function to create positions (extracted for reuse)
async function createPositionsIfNeeded(
    config: TradeConfig,
    client: SuiClient,
    keypair: Ed25519Keypair,
    userAddress: string,
    apiInstance: IBaseAPI,
    indexPrice: number,
    collateralPrice: number,
    coinType: string,
    positions: any[],
) {
    const hasLongPosition = positions.some(
        (pos) =>
            pos.indexToken === config.indexToken && pos.long && !pos.closed,
    );

    const hasShortPosition = positions.some(
        (pos) =>
            pos.indexToken === config.indexToken && !pos.long && !pos.closed,
    );

    // Get the size from existing primary position if it exists, otherwise calculate it
    let primaryTradeSize: bigint | undefined = undefined;
    if (config.long && hasLongPosition) {
        // Get size from existing long position
        const existingPosition = positions.find(
            (pos) =>
                pos.indexToken === config.indexToken && pos.long && !pos.closed,
        );
        if (existingPosition) {
            primaryTradeSize = BigInt(existingPosition.positionAmount.toString());
            console.log(
                `Using existing LONG position size: ${primaryTradeSize}`,
            );
        }
    } else if (!config.long && hasShortPosition) {
        // Get size from existing short position
        const existingPosition = positions.find(
            (pos) =>
                pos.indexToken === config.indexToken &&
                !pos.long &&
                !pos.closed,
        );
        if (existingPosition) {
            primaryTradeSize = BigInt(existingPosition.positionAmount.toString());
            console.log(
                `Using existing SHORT position size: ${primaryTradeSize}`,
            );
        }
    }

    // Check if we need to create the primary position
    if (!hasLongPosition && config.long) {
        primaryTradeSize = calculateTradeSize(config);
        await createPosition(
            config,
            true, // long
            indexPrice,
            collateralPrice,
            coinType,
            client,
            keypair,
            userAddress,
            apiInstance,
            dataAPIInstance,
            primaryTradeSize,
        );
    } else if (!hasShortPosition && !config.long) {
        primaryTradeSize = calculateTradeSize(config);
        await createPosition(
            config,
            false, // short
            indexPrice,
            collateralPrice,
            coinType,
            client,
            keypair,
            userAddress,
            apiInstance,
            dataAPIInstance,
            primaryTradeSize,
        );
    }

    // Check if we need to create the opposite position for hedging
    if (config.createOpposite) {
        if (!hasLongPosition && !config.long) {
            // Create opposite long position if main is short
            // Use the same size as the primary position
            const oppositeSize =
                primaryTradeSize !== undefined
                    ? primaryTradeSize
                    : calculateTradeSize(config);
            await createPosition(
                config,
                true, // long
                indexPrice,
                collateralPrice,
                coinType,
                client,
                keypair,
                userAddress,
                apiInstance,
                dataAPIInstance,
                oppositeSize,
            );
        } else if (!hasShortPosition && config.long) {
            // Create opposite short position if main is long
            // Use the same size as the primary position
            const oppositeSize =
                primaryTradeSize !== undefined
                    ? primaryTradeSize
                    : calculateTradeSize(config);
            await createPosition(
                config,
                false, // short
                indexPrice,
                collateralPrice,
                coinType,
                client,
                keypair,
                userAddress,
                apiInstance,
                dataAPIInstance,
                oppositeSize,
            );
        }
    }
}

export async function tradeWithMarketOrder(config: TradeConfig) {
    try {
        console.log('Starting...');
        const client = getConnection();
        const keypair = getKeypair();
        const userAddress = keypair.getPublicKey().toSuiAddress();

        console.log(`Using address: ${userAddress}`);
        console.log(
            `Trade config: ${config.long ? 'LONG' : 'SHORT'} ${config.indexToken}, collateral: ${config.collateralToken}`,
        );
        if (config.createOpposite) {
            console.log(`Will also create opposite position for hedging`);
        }

        switch (config.pool) {
            case LPToken.ZLP: {
                apiInstance = getZLPAPIInstance();
                dataAPIInstance = getZLPDataAPIInstance();
                break;
            }
            case LPToken.SLP: {
                apiInstance = getSLPAPIInstance();
                dataAPIInstance = getSLPDataAPIInstance();
                break;
            }
            case LPToken.USDZ: {
                apiInstance = getUSDZAPIInstance();
                dataAPIInstance = getUSDZDataAPIInstance();
                break;
            }
            default: {
                apiInstance = getZLPAPIInstance();
                dataAPIInstance = getZLPDataAPIInstance();
            }
        }

        let isTrading = false;
        let shouldContinueTrading = true;

        // Define the trading logic as a reusable function
        let intervalId: NodeJS.Timeout;
        const executeTradingLogic = async () => {
            if (isTrading) return;
            isTrading = true;

            // Check if we should stop trading due to volume limit
            if (!shouldContinueTrading) {
                console.log('Stopping trading interval due to volume limit');
                if (intervalId) clearInterval(intervalId);
                process.exit(0);
                return;
            }

            try {
                const indexPrice = await fetchPrice(config.indexToken);
                const collateralPrice = await fetchPrice(
                    config.collateralToken,
                );

                console.log(
                    `current price: ${config.indexToken} = ${indexPrice}, ${config.collateralToken} = ${collateralPrice}`,
                );

                const positionCaps =
                    await dataAPIInstance.getPositionCapInfoList(userAddress);
                const orderCaps =
                    await dataAPIInstance.getOrderCapInfoList(userAddress);

                // Get all position info (both open and closed)
                const allPositions = await dataAPIInstance.getPositionInfoList(
                    positionCaps,
                    userAddress,
                );

                // Get position info and filter closed positions
                const positions = allPositions.filter((ps) => !ps.closed);

                // Get closed positions
                const closedPositions = allPositions.filter((ps) => ps.closed);

                // Get all orders
                const orders = await dataAPIInstance.getOrderInfoList(
                    orderCaps,
                    userAddress,
                );

                // Get executed orders
                const executedOrders = orders.filter((order) => order.executed);

                console.log(`positions: ${positions.length}`);
                console.log(`orders: ${orders.length}`);

                // Clear closed positions and executed orders
                await clearPositionsAndOrders(
                    client,
                    keypair,
                    closedPositions,
                    executedOrders,
                    userAddress,
                );

                // Ensure we have enough coins by splitting if necessary
                const coinType =
                    deployments.coins[config.collateralToken].module;

                // Track if any positions were closed
                const positionsToClose = positions.filter(
                    (pos) => pos.indexToken === config.indexToken,
                );
                let positionsClosed = positionsToClose.length > 0;

                // Check for existing positions that need to be closed
                for (const position of positionsToClose) {
                    await closePosition(
                        client,
                        keypair,
                        position.id,
                        position.collateralToken,
                        coinType,
                        position.indexToken,
                        BigInt(position.positionAmount),
                        position.long,
                        userAddress,
                        config,
                        apiInstance,
                    );
                }

                // If positions were closed, immediately check and create new positions
                // without waiting for the next interval
                if (positionsClosed) {
                    console.log(
                        'Positions were closed, immediately checking for new positions to create...',
                    );
                    // Wait a bit for the blockchain to update
                    await new Promise((resolve) => setTimeout(resolve, 5000));

                    // Refresh position data after closing
                    const updatedPositionCaps =
                        await dataAPIInstance.getPositionCapInfoList(
                            userAddress,
                        );
                    const updatedPositions = (
                        await dataAPIInstance.getPositionInfoList(
                            updatedPositionCaps,
                            userAddress,
                        )
                    ).filter((ps) => !ps.closed);

                    // Get fresh prices
                    const freshIndexPrice = await fetchPrice(config.indexToken);
                    const freshCollateralPrice = await fetchPrice(
                        config.collateralToken,
                    );

                    // Create positions immediately
                    await createPositionsIfNeeded(
                        config,
                        client,
                        keypair,
                        userAddress,
                        apiInstance,
                        freshIndexPrice,
                        freshCollateralPrice,
                        coinType,
                        updatedPositions,
                    );
                } else {
                    // No positions were closed, just check and create positions normally
                    await createPositionsIfNeeded(
                        config,
                        client,
                        keypair,
                        userAddress,
                        apiInstance,
                        indexPrice,
                        collateralPrice,
                        coinType,
                        positions,
                    );
                }
            } catch (error) {
                console.error('trade bot execution error:', error);
            } finally {
                isTrading = false;
            }
        };

        // Execute immediately without waiting for the first interval
        executeTradingLogic();

        // Then set up the interval for subsequent executions
        intervalId = setInterval(executeTradingLogic, config.tradeInterval);
    } catch (error) {
        console.error('trade bot initialization failed:', error);
        process.exit(1);
    }
}

// Function to clear closed positions and executed orders
async function clearPositionsAndOrders(
    client: SuiClient,
    signer: Ed25519Keypair,
    closedPositions: any[],
    executedOrders: any[],
    userAddress: string,
) {
    try {
        if (closedPositions.length === 0 && executedOrders.length === 0) {
            return; // Nothing to clear
        }

        console.log(
            `Clearing ${closedPositions.length} closed positions and ${executedOrders.length} executed orders...`,
        );

        // Create transaction block
        const txb = new Transaction();

        // Clear closed positions
        for (const position of closedPositions) {
            apiInstance.clearClosedPosition(
                position.id,
                position.collateralToken,
                position.indexToken,
                position.long,
                txb,
            );
        }

        // Clear executed orders
        for (const order of executedOrders) {
            if (order.orderType === 'OPEN_POSITION') {
                apiInstance.clearOpenPositionOrder(
                    order.capId,
                    order.collateralToken,
                    order.indexToken,
                    order.long,
                    txb,
                    order.v11Order,
                );
            } else if (order.orderType === 'DECREASE_POSITION') {
                apiInstance.clearDecreasePositionOrder(
                    order.capId,
                    order.collateralToken,
                    order.indexToken,
                    order.long,
                    txb,
                    order.v11Order,
                );
            } else if (order.orderType === 'OPEN_MARKET') {
                apiInstance.clearOpenMarketOrder!(
                    order.capId,
                    order.collateralToken,
                    order.indexToken,
                    order.long,
                    txb,
                    false,
                );
            } else if (order.orderType === 'DECREASE_MARKET') {
                apiInstance.clearDecreaseMarketOrder!(
                    order.capId,
                    order.collateralToken,
                    order.indexToken,
                    order.long,
                    txb,
                    false,
                );
            }
        }

        txb.setSender(userAddress);
        txb.setGasBudget(1e9);

        // Dry run the transaction
        const dryRunResult = await client.dryRunTransactionBlock({
            transactionBlock: await txb.build({
                client,
            }),
        });

        if (dryRunResult.effects.status.status === 'failure') {
            console.error(
                'Failed to dry run clearing transaction: ',
                dryRunResult.effects.status.error,
            );
            throw new Error(dryRunResult.effects.status.error);
        }

        // Execute the transaction
        const result = await client.signAndExecuteTransaction({
            transaction: txb,
            signer,
        });

        console.log(
            `Cleared positions and orders, transaction id: ${result?.digest}`,
        );
        return result;
    } catch (error) {
        console.error('Failed to clear positions and orders:', error);
        return null;
    }
}
