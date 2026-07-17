import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import {
    SDK,
    Network,
    LPToken,
    type IZLPAPI,
    type ISLPAPI,
    type IUSDZAPI,
    type IZLPDataAPI,
    type ISLPDataAPI,
    type IUSDZDataAPI,
    type IBaseDataAPI,
    type SuiClient,
} from '@zofai/zo-sdk';
import { NETWORK } from './network';

/**
 * Typed trading API with openPositionV3 / decreasePositionV3 (Pyth Pro).
 * Concrete API classes also implement IBaseDataAPI (incl. fetchPythProUpdateBytesForTokens).
 */
export type TradingAPI = (IZLPAPI | ISLPAPI | IUSDZAPI) & IBaseDataAPI;
export type TradingDataAPI = IZLPDataAPI | ISLPDataAPI | IUSDZDataAPI;

export const ZO_API_ENDPOINT = 'https://api.zofinance.io';
/** ZO-hosted Hermes / Pyth Pro proxy (see zo-sdk getting-started docs). */
export const HERMES_URL = 'https://hermes.zofinance.io';

export function getConnection(): SuiClient {
    let rpcUrl: string;

    if (NETWORK === Network.MAINNET) {
        rpcUrl =
            process.env.SUI_MAINNET_RPC_URL ||
            'https://fullnode.mainnet.sui.io:443';
    } else if (NETWORK === Network.TESTNET) {
        rpcUrl =
            process.env.SUI_TESTNET_RPC_URL ||
            'https://fullnode.testnet.sui.io:443';
    } else {
        throw new Error(`unsupported network: ${NETWORK}`);
    }

    // Sui SDK 2.x: SuiJsonRpcClient replaces the removed SuiClient class
    return new SuiJsonRpcClient({
        url: rpcUrl,
        network: NETWORK === Network.TESTNET ? 'testnet' : 'mainnet',
    });
}

export function getZLPAPIInstance(
    network: Network = Network.MAINNET,
    apiEndpoint = ZO_API_ENDPOINT,
    connectionURL = HERMES_URL,
): TradingAPI {
    return SDK.getInstance().createZLPAPI(
        network,
        getConnection(),
        apiEndpoint,
        connectionURL,
    ) as TradingAPI;
}

export function getSLPAPIInstance(
    network: Network = Network.MAINNET,
    apiEndpoint = ZO_API_ENDPOINT,
    connectionURL = HERMES_URL,
): TradingAPI {
    return SDK.getInstance().createSLPAPI(
        network,
        getConnection(),
        apiEndpoint,
        connectionURL,
    ) as TradingAPI;
}

export function getUSDZAPIInstance(
    network: Network = Network.MAINNET,
    apiEndpoint = ZO_API_ENDPOINT,
    connectionURL = HERMES_URL,
): TradingAPI {
    return SDK.getInstance().createUSDZAPI(
        network,
        getConnection(),
        apiEndpoint,
        connectionURL,
    ) as TradingAPI;
}

export function getZLPDataAPIInstance(
    network: Network = Network.MAINNET,
    apiEndpoint = ZO_API_ENDPOINT,
    connectionURL = HERMES_URL,
): IZLPDataAPI {
    return SDK.getInstance().createZLPDataAPI(
        network,
        getConnection(),
        apiEndpoint,
        connectionURL,
    );
}

export function getSLPDataAPIInstance(
    network: Network = Network.MAINNET,
    apiEndpoint = ZO_API_ENDPOINT,
    connectionURL = HERMES_URL,
): ISLPDataAPI {
    return SDK.getInstance().createSLPDataAPI(
        network,
        getConnection(),
        apiEndpoint,
        connectionURL,
    );
}

export function getUSDZDataAPIInstance(
    network: Network = Network.MAINNET,
    apiEndpoint = ZO_API_ENDPOINT,
    connectionURL = HERMES_URL,
): IUSDZDataAPI {
    return SDK.getInstance().createUSDZDataAPI(
        network,
        getConnection(),
        apiEndpoint,
        connectionURL,
    );
}

/** Resolve trading + data API for a pool. */
export function getAPIAndDataAPI(pool: LPToken): {
    api: TradingAPI;
    dataAPI: TradingDataAPI;
} {
    switch (pool) {
        case LPToken.ZLP:
            return {
                api: getZLPAPIInstance(),
                dataAPI: getZLPDataAPIInstance(),
            };
        case LPToken.SLP:
            return {
                api: getSLPAPIInstance(),
                dataAPI: getSLPDataAPIInstance(),
            };
        case LPToken.USDZ:
            return {
                api: getUSDZAPIInstance(),
                dataAPI: getUSDZDataAPIInstance(),
            };
        default:
            return {
                api: getZLPAPIInstance(),
                dataAPI: getZLPDataAPIInstance(),
            };
    }
}
