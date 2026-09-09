import {
    getZLPAPIInstance,
    getZLPDataAPIInstance,
    getConnection,
    getAPIAndDataAPI,
    simulateOrThrow,
    signAndExecuteTx,
    type TradingAPI,
    type TradingDataAPI,
    type ZoSuiClient,
} from './connection';
import { getKeypair } from './keypair';
import { ensureBotTraderVerified } from './bot-trader';
import {
    calculateRelayerFeeInToken,
    calculateReserveAmount,
    GetAllCoin,
} from './utils';
import { DEFAULT_SLIPPAGE } from './constants';
import { fetchTokenUsdPrice } from './prices';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import BigNumber from 'bignumber.js';
import { getDeployments } from './deployments';
import { Transaction } from '@mysten/sui/transactions';
import { LPToken } from '@zofai/zo-sdk';
import { fetchTraderPositionsFromApi } from './indexer';

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

let apiInstance: TradingAPI = getZLPAPIInstance();
let dataAPIInstance: TradingDataAPI = getZLPDataAPIInstance();
let deployments = getDeployments(LPToken.ZLP);

/** Pyth Pro update bytes for collateral + index (required by *V3 trade methods). */
async function fetchTradeOracleUpdate(
    api: TradingAPI,
    collateralToken: string,
    indexToken: string,
) {
    return api.fetchPythProUpdateBytesForTokens([collateralToken, indexToken]);
}

async function fetchPrice(token: string): Promise<number> {
    return fetchTokenUsdPrice(apiInstance, token);
}

/** Indexed OPEN positions from ZO API `/trader-positions` (no RPC hydrate). */
async function loadOpenPositions(owner: string, config: TradeConfig) {
    return fetchTraderPositionsFromApi(
        owner,
        config.pool,
        deployments,
        {
            status: 'OPEN',
            indexToken: config.indexToken,
            collateralToken: config.collateralToken,
        },
    );
}

/** Indexed live orders (zo API `/open-orders`). */
async function loadOpenOrders(owner: string, config: TradeConfig) {
    return dataAPIInstance.getTraderOpenOrderInfoList(owner, {
        indexToken: config.indexToken,
        collateralToken: config.collateralToken,
    });
}

async function waitForOpenPosition(
    owner: string,
    config: TradeConfig,
    direction: boolean,
) {
    for (let i = 0; i < 8; i++) {
        const positions = await loadOpenPositions(owner, config);
        const found = positions.find((p) => p.long === direction);
        if (found) {
            return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return undefined;
}

function bindPoolApis(pool: LPToken) {
    const { api, dataAPI } = getAPIAndDataAPI(pool);
    apiInstance = api;
    dataAPIInstance = dataAPI;
    deployments = getDeployments(pool);
}

/** Closed positions + executed orders from ZO API (`/trader-positions`, `/open-orders`). */
async function loadCleanupState(owner: string) {
    const closedPositions = await fetchTraderPositionsFromApi(
        owner,
        apiInstance.lpToken,
        deployments,
        { status: 'CLOSED' },
    );
    const orders = await dataAPIInstance.getTraderOpenOrderInfoList(owner, {
        includeFailed: true,
    });
    return {
        closedPositions,
        executedOrders: orders.filter((order) => order.executed),
    };
}

// Add a global volume counter
let totalTradedVolumeUSD = 0;
const DEFAULT_MAX_VOLUME_USD = 4000000; // 4 million USD

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
    client: ZoSuiClient,
    keypair: Ed25519Keypair,
    userAddress: string,
    apiInstance: TradingAPI,
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

        const pythProUpdateBytes = await fetchTradeOracleUpdate(
            apiInstance,
            config.collateralToken,
            config.indexToken,
        );

        const tx = await apiInstance.openPositionV3(
            config.collateralToken,
            config.indexToken,
            tradeSize,
            config.collateralAmount,
            coinObjects.map((c) => c.coinObjectId),
            direction,
            reserveAmount,
            indexPrice,
            collateralPrice,
            pythProUpdateBytes,
            false,
            false,
            DEFAULT_SLIPPAGE,
            DEFAULT_SLIPPAGE,
            relayerFeeAmount,
            '',
            userAddress,
            false,
        );

        tx.setSender(userAddress);
        tx.setGasBudget(1e9);

        await simulateOrThrow(client, tx, 'open position');
        const res = await signAndExecuteTx(client, tx, keypair);

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

            const newPosition = await waitForOpenPosition(
                userAddress,
                config,
                direction,
            );
            if (newPosition) {
                return true;
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
    client: ZoSuiClient,
    signer: Ed25519Keypair,
    positionId: string,
    collateralToken: string,
    collateralTokenType: string,
    indexToken: string,
    amount: bigint,
    long: boolean,
    userAddress: string,
    config: TradeConfig,
    apiInstance: TradingAPI,
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

        const pythProUpdateBytes = await fetchTradeOracleUpdate(
            apiInstance,
            collateralToken,
            indexToken,
        );

        const tx1 = await apiInstance.decreasePositionV3(
            positionId,
            collateralToken,
            indexToken,
            amount,
            long,
            indexPrice,
            collateralPrice,
            pythProUpdateBytes,
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

        await simulateOrThrow(client, tx1, 'close position');
        const res1 = await signAndExecuteTx(client, tx1, signer);

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

/**
 * Add collateral to an open position.
 * Move `pledge_in_position` does not take an oracle update.
 */
export async function pledgeInOpenPosition(
    config: TradeConfig,
    positionId: string,
    amount: bigint,
): Promise<boolean> {
    bindPoolApis(config.pool);
    const client = getConnection();
    const keypair = getKeypair();
    const userAddress = keypair.getPublicKey().toSuiAddress();
    const coinType = deployments.coins[config.collateralToken].module;
    const coins = await GetAllCoin(client, userAddress, coinType);

    const tx = await apiInstance.pledgeInPosition(
        positionId,
        config.collateralToken,
        config.indexToken,
        Number(amount),
        coins.map((c) => c.coinObjectId),
        config.long,
        false,
        userAddress,
    );
    tx.setSender(userAddress);
    tx.setGasBudget(1e9);
    await simulateOrThrow(client, tx, 'pledge in position');
    const res = await signAndExecuteTx(client, tx, keypair);
    console.log(`pledged ${amount} into ${positionId}, tx ${res?.digest}`);
    return Boolean(res?.digest);
}

/**
 * Withdraw collateral from an open position.
 * SLP: `redeemFromPositionV3`. ZLP / USDZ: `redeemFromPositionV2` (Pyth Pro).
 */
export async function redeemFromOpenPosition(
    config: TradeConfig,
    positionId: string,
    amount: bigint,
): Promise<boolean> {
    bindPoolApis(config.pool);
    const client = getConnection();
    const keypair = getKeypair();
    const userAddress = keypair.getPublicKey().toSuiAddress();
    const pythProUpdateBytes = await fetchTradeOracleUpdate(
        apiInstance,
        config.collateralToken,
        config.indexToken,
    );

    const tx = await buildRedeemTx(
        apiInstance,
        positionId,
        config.collateralToken,
        config.indexToken,
        Number(amount),
        config.long,
        pythProUpdateBytes,
    );
    tx.setSender(userAddress);
    tx.setGasBudget(1e9);
    await simulateOrThrow(client, tx, 'redeem from position');
    const res = await signAndExecuteTx(client, tx, keypair);
    console.log(`redeemed ${amount} from ${positionId}, tx ${res?.digest}`);
    return Boolean(res?.digest);
}

async function buildRedeemTx(
    api: TradingAPI,
    pcpId: string,
    collateralToken: string,
    indexToken: string,
    amount: number,
    long: boolean,
    pythProUpdateBytes: Uint8Array | number[],
) {
    if (
        'redeemFromPositionV3' in api &&
        typeof api.redeemFromPositionV3 === 'function'
    ) {
        return api.redeemFromPositionV3(
            pcpId,
            collateralToken,
            indexToken,
            amount,
            long,
            pythProUpdateBytes,
        );
    }
    if (
        'redeemFromPositionV2' in api &&
        typeof api.redeemFromPositionV2 === 'function'
    ) {
        return api.redeemFromPositionV2(
            pcpId,
            collateralToken,
            indexToken,
            amount,
            long,
            pythProUpdateBytes,
        );
    }
    return api.redeemFromPosition(
        pcpId,
        collateralToken,
        indexToken,
        amount,
        long,
    );
}

async function createPositionWithTPSLOrders(
    config: TradeConfig,
    direction: boolean, // true for long, false for short
    indexPrice: number,
    collateralPrice: number,
    collateralTokenType: string,
    client: ZoSuiClient,
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

        const pythProUpdateBytes = await fetchTradeOracleUpdate(
            apiInstance,
            config.collateralToken,
            config.indexToken,
        );

        const tx = await apiInstance.openPositionV3(
            config.collateralToken,
            config.indexToken,
            tradeSize,
            config.collateralAmount,
            coinObjects.map((c) => c.coinObjectId),
            direction,
            reserveAmount,
            indexPrice,
            collateralPrice,
            pythProUpdateBytes,
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

        await simulateOrThrow(client, tx, 'open position');
        const res = await signAndExecuteTx(client, tx, keypair);

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

            const newPosition = await waitForOpenPosition(
                userAddress,
                config,
                direction,
            );
            if (newPosition) {
                const { takeProfitPrice, stopLossPrice } = calculateTPSLPrices(
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

        await ensureBotTraderVerified(keypair);

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

        bindPoolApis(config.pool);

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

                const positions = await loadOpenPositions(userAddress, config);
                const orders = await loadOpenOrders(userAddress, config);
                const { closedPositions, executedOrders } =
                    await loadCleanupState(userAddress);

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
                    const updatedPositions = await loadOpenPositions(
                        userAddress,
                        config,
                    );

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
    client: ZoSuiClient,
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

            const pythProUpdateBytes = await fetchTradeOracleUpdate(
                apiInstance,
                collateralToken,
                indexToken,
            );

            const tx1 = await apiInstance.decreasePositionV3(
                positionId,
                collateralToken,
                indexToken,
                amount,
                long,
                takeProfitPrice,
                collateralPrice,
                pythProUpdateBytes,
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

            await simulateOrThrow(client, tx1, 'take profit order');
            const res1 = await signAndExecuteTx(client, tx1, signer);

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
            const pythProUpdateBytes = await fetchTradeOracleUpdate(
                apiInstance,
                collateralToken,
                indexToken,
            );

            const tx2 = await apiInstance.decreasePositionV3(
                positionId,
                collateralToken,
                indexToken,
                amount,
                long,
                stopLossPrice,
                collateralPrice,
                pythProUpdateBytes,
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

            await simulateOrThrow(client, tx2, 'stop loss order');
            const res2 = await signAndExecuteTx(client, tx2, signer);

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
    client: ZoSuiClient,
    keypair: Ed25519Keypair,
    userAddress: string,
    apiInstance: TradingAPI,
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

        await ensureBotTraderVerified(keypair);

        console.log(`Using address: ${userAddress}`);
        console.log(
            `Trade config: ${config.long ? 'LONG' : 'SHORT'} ${config.indexToken}, collateral: ${config.collateralToken}`,
        );
        if (config.createOpposite) {
            console.log(`Will also create opposite position for hedging`);
        }

        bindPoolApis(config.pool);

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

                const positions = await loadOpenPositions(userAddress, config);
                const { closedPositions, executedOrders } =
                    await loadCleanupState(userAddress);

                console.log(`positions: ${positions.length}`);

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
                    const updatedPositions = await loadOpenPositions(
                        userAddress,
                        config,
                    );

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
    client: ZoSuiClient,
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

        await simulateOrThrow(client, txb, 'clear positions and orders');
        const result = await signAndExecuteTx(client, txb, signer);

        console.log(
            `Cleared positions and orders, transaction id: ${result?.digest}`,
        );
        return result;
    } catch (error) {
        console.error('Failed to clear positions and orders:', error);
        return null;
    }
}
