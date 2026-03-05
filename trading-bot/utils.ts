import {
    GetCoinsParams,
    GetOwnedObjectsParams,
    SuiClient,
} from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { DEFAULT_RELAYER_FEE } from './constants';

export async function GetOwnedObjects(
    client: SuiClient,
    owner: string,
    packageId: string,
    module: string,
): Promise<any[]> {
    let objects: any[] = [];
    let options: GetOwnedObjectsParams = {
        owner: owner,
        limit: 50,
        options: {
            showType: true,
            showDisplay: true,
            showContent: true,
        },
        filter: {
            MoveModule: {
                module: module,
                package: packageId,
            },
        },
    };

    while (true) {
        let resp = await client.getOwnedObjects(options);
        for (let item of resp.data) {
            if (item.data) {
                objects.push(item.data);
            }
        }
        if (!resp.hasNextPage) {
            break;
        } else {
            options.cursor = resp.nextCursor;
        }
    }
    return objects;
}

export async function GetAllCoin(
    client: SuiClient,
    owner: string,
    coinType: string,
): Promise<any[]> {
    let allCoins: any[] = [];
    let nextCursor = '';
    while (true) {
        let params: GetCoinsParams = { owner: owner, coinType: coinType };
        if (nextCursor != '') {
            params.cursor = nextCursor;
        }
        let resp = await client.getCoins(params);
        allCoins = [...allCoins, ...resp.data];

        if (!resp.hasNextPage) {
            break;
        }
        if (resp.nextCursor != null && resp.nextCursor != undefined) {
            nextCursor = resp.nextCursor;
        }
    }
    return allCoins;
}

export async function SplitCoins(
    client: SuiClient,
    owner: string,
    coinType: string,
    txb: Transaction,
    amount: number,
): Promise<any> {
    if (coinType == '0x2::sui::SUI') {
        const [coin] = txb.splitCoins(txb.gas, [txb.pure.u64(amount)]);
        return coin;
    }
    const [targetCoin, ...sourceCoins] = await GetAllCoin(
        client,
        owner,
        coinType,
    );
    let tCoin = txb.object(targetCoin.coinObjectId);
    if (sourceCoins.length) {
        if (sourceCoins.length > 200) {
            txb.mergeCoins(
                tCoin,
                sourceCoins
                    .slice(0, 200)
                    .map((c) => txb.object(c.coinObjectId)),
            );
        } else {
            txb.mergeCoins(
                tCoin,
                sourceCoins.map((c) => txb.object(c.coinObjectId)),
            );
        }
    }
    let [coin] = txb.splitCoins(tCoin, [txb.pure.u64(amount)]);
    return coin;
}

/** Max leverage for reserve calculation (cap reserved amount at 10x collateral) */
const MAX_RESERVE_LEVERAGE = 10;

/**
 * Calculate reserve amount based on leverage. Reserve = collateralAmount * min(leverage, maxReservedMultiplier, 10).
 * Leverage = positionSizeUSD / collateralValueUSD.
 */
export function calculateReserveAmount(
    tradeSize: bigint,
    collateralAmount: bigint,
    indexPrice: number,
    collateralPrice: number,
    indexDecimals: number,
    collateralDecimals: number,
    maxReservedMultiplier: number,
): bigint {
    const collateralValueUSD =
        (Number(collateralAmount) * collateralPrice) / 10 ** collateralDecimals;
    const positionSizeUSD =
        (Number(tradeSize) * indexPrice) / 10 ** indexDecimals;
    if (collateralValueUSD <= 0) return BigInt(0);
    const leverage = positionSizeUSD / collateralValueUSD;
    const multiplier = Math.min(
        leverage,
        maxReservedMultiplier || 0,
        MAX_RESERVE_LEVERAGE,
    );
    return BigInt(Math.floor(Number(collateralAmount) * multiplier));
}

// Calculate the relayer fee in collateral token
export const calculateRelayerFeeInToken = (collateralPrice: number) => {
    if (!collateralPrice || collateralPrice === 0) {
        return 0;
    }
    // Calculate the amount of collateral token needed to cover the RELAYER_FEE in USD
    return (DEFAULT_RELAYER_FEE / collateralPrice) * 1.02;
};
