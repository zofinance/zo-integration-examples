import { getKeypair } from './keypair';
import { deployments } from './deployments';
import { GetOwnedObjects, SplitCoins } from './utils';
import { SuiClient } from '@mysten/sui/client';

export interface OrderKey {
    vaultKey: string;
    symbolKey: {
        index: string;
        direction: string;
    };
    orderType: string;
    isTakeProfit: boolean;
}

export interface OrderInfo {
    id: string;
    type: string;
    key?: OrderKey;
}

export function extractOrderKey(typeStr: string): OrderKey | undefined {
    try {
        // example type:
        // 0xf7fade57462e56e2eff1d7adef32e4fd285b21fd81f983f407bb7110ca766cda::market::OrderCap<0x2::sui::SUI, 0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN, 0xf7fade57462e56e2eff1d7adef32e4fd285b21fd81f983f407bb7110ca766cda::market::LONG>

        if (!typeStr.includes('::market::OrderCap<')) {
            return undefined;
        }

        const genericParamsMatch = typeStr.match(/<(.+)>/);
        if (!genericParamsMatch || !genericParamsMatch[1]) {
            return undefined;
        }

        const genericParams = genericParamsMatch[1].split(', ');
        if (genericParams.length < 3) {
            return undefined;
        }

        let orderType = 'LIMIT';
        let isTakeProfit = false;

        return {
            vaultKey: genericParams[0],
            symbolKey: {
                index: genericParams[1],
                direction: genericParams[2],
            },
            orderType,
            isTakeProfit,
        };
    } catch (error) {
        console.error('extract order key failed:', error);
        return undefined;
    }
}

export function isOrderCap(typeStr: string): boolean {
    return typeStr.includes('::market::OrderCap<');
}

export async function getOrderCaps(client: SuiClient, sender: string = '') {
    try {
        // if sender is not provided, use the address of the current keypair
        if (!sender) {
            const keypair = getKeypair();
            sender = keypair.getPublicKey().toSuiAddress();
        }

        // call GetOwnedObjects to get all order objects
        const objects = await GetOwnedObjects(
            client,
            sender,
            deployments.zoCore.package,
            'market',
        );

        // filter out orders
        const orders: OrderInfo[] = [];

        for (const obj of objects) {
            if (!obj.content || !obj.content.type) continue;

            const type = obj.content.type;
            if (isOrderCap(type)) {
                const orderInfo: OrderInfo = {
                    id: obj.objectId,
                    type: type,
                    key: extractOrderKey(type),
                };
                orders.push(orderInfo);
            }
        }

        return orders;
    } catch (error) {
        console.error('get all orders failed:', error);
        throw error;
    }
}

export async function getOrderDetails(client: SuiClient, orderId: string) {
    try {
        const result = await client.getObject({
            id: orderId,
            options: {
                showContent: true,
                showType: true,
                showOwner: true,
                showDisplay: true,
            },
        });

        return result;
    } catch (error) {
        console.error('get order details failed:', error);
        throw error;
    }
}
