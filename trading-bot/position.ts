import { getKeypair } from './keypair';
import { deployments } from './deployments';
import { GetOwnedObjects, SplitCoins } from './utils';
import { SuiClient } from '@mysten/sui/client';

export interface PositionKey {
    vaultKey: string;
    symbolKey: {
        index: string;
        direction: string;
    };
}

export interface PositionInfo {
    id: string;
    type: string;
    key?: PositionKey;
}

/**
 * Extract position key from type
 * @param typeStr position type string
 * @returns position key object
 */
export function extractPositionKey(typeStr: string): PositionKey | undefined {
    try {
        // Example type:
        // 0xf7fade57462e56e2eff1d7adef32e4fd285b21fd81f983f407bb7110ca766cda::market::PositionCap<0x2::sui::SUI, 0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN, 0xf7fade57462e56e2eff1d7adef32e4fd285b21fd81f983f407bb7110ca766cda::market::LONG>

        // Check if it's the expected format
        if (!typeStr.includes('::market::')) {
            return undefined;
        }

        // Extract the generic parameters between < and >
        const genericParamsMatch = typeStr.match(/<(.+)>/);
        if (!genericParamsMatch || !genericParamsMatch[1]) {
            return undefined;
        }

        // Split the generic parameters by comma
        const genericParams = genericParamsMatch[1].split(', ');
        if (genericParams.length < 3) {
            return undefined;
        }

        return {
            vaultKey: genericParams[0], // 0x2::sui::SUI
            symbolKey: {
                index: genericParams[1], // 0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN
                direction: genericParams[2], // 0xf7fade57462e56e2eff1d7adef32e4fd285b21fd81f983f407bb7110ca766cda::market::LONG
            },
        };
    } catch (error) {
        console.error('Failed to extract position key:', error);
        return undefined;
    }
}

/**
 * Check if a type is a position cap
 * @param typeStr type string
 * @returns true if it's a position cap
 */
export function isPositionCap(typeStr: string): boolean {
    return typeStr.includes('::market::PositionCap<');
}

export async function getPositionCaps(client: SuiClient, sender: string = '') {
    try {
        // Get keypair if sender is not provided
        if (!sender) {
            const keypair = getKeypair();
            sender = keypair.getPublicKey().toSuiAddress();
        }

        // Call GetOwnedObjects to get all objects owned by the address
        const objects = await GetOwnedObjects(
            client,
            sender,
            deployments.zoCore.package,
            'market',
        );
        // Separate positions and orders
        const positions: PositionInfo[] = [];

        for (const obj of objects) {
            if (!obj.content || !obj.content.type) continue;
            const type = obj.content.type;
            if (isPositionCap(type)) {
                const positionInfo: PositionInfo = {
                    id: obj.objectId,
                    type: type,
                    key: extractPositionKey(type),
                };
                positions.push(positionInfo);
            }
        }

        return positions;
    } catch (error) {
        console.error('Get all positions failed:', error);
        throw error;
    }
}

/**
 * Get position details
 * @param client SUI client
 * @param positionId position ID
 * @returns position details
 */
export async function getPositionDetails(
    client: SuiClient,
    positionId: string,
) {
    try {
        const result = await client.getObject({
            id: positionId,
            options: {
                showContent: true,
                showType: true,
                showOwner: true,
                showDisplay: true,
            },
        });

        return result;
    } catch (error) {
        console.error('Get position details failed:', error);
        throw error;
    }
}

/**
 * Process slippage for price
 * @param price original price
 * @param isIncrease whether to increase the price
 * @param slippage slippage percentage
 * @returns adjusted price
 */
function processSlippage(
    price: number,
    isIncrease: boolean,
    slippage: number,
): number {
    if (slippage === 0) return price;

    const adjustmentFactor = isIncrease
        ? 1 + slippage // Increase price (worse for longs)
        : 1 - slippage; // Decrease price (worse for shorts)

    return Math.floor(price * adjustmentFactor);
}
