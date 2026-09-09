import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import {
    SDK,
    Network,
    LPToken,
    createSuiProvider,
    withJsonRpcCompat,
    type IZLPAPI,
    type ISLPAPI,
    type IUSDZAPI,
    type IBaseDataAPI,
} from '@zofai/zo-sdk';
import { NETWORK } from './network';

/**
 * Typed trading API with V3 Pyth Pro methods plus DataAPI reads
 * (`fetchPythProUpdateBytesForTokens`, `getTraderOpenPositionInfoList`, …).
 */
export type TradingAPI = (IZLPAPI | ISLPAPI | IUSDZAPI) & IBaseDataAPI;
export type TradingDataAPI = IBaseDataAPI;

/** gRPC client plus JSON-RPC-compat helpers from zo-sdk (`getCoins`, `getOwnedObjects`, …). */
export type ZoSuiClient = ReturnType<typeof createSuiProvider>;

export const ZO_API_ENDPOINT = 'https://api.zofinance.io';
/** ZO-hosted Hermes / Pyth Pro proxy (see zo-sdk getting-started docs). */
export const HERMES_URL = 'https://api.zofinance.io';

let provider: ZoSuiClient | null = null;

export function getConnection(): ZoSuiClient {
    if (provider) {
        return provider;
    }

    const customUrl =
        NETWORK === Network.TESTNET
            ? process.env.SUI_TESTNET_RPC_URL
            : process.env.SUI_MAINNET_RPC_URL;

    if (customUrl) {
        const network = NETWORK === Network.TESTNET ? 'testnet' : 'mainnet';
        provider = withJsonRpcCompat(
            new SuiGrpcClient({ network, baseUrl: customUrl }),
        );
    } else {
        provider = createSuiProvider(NETWORK);
    }

    return provider;
}

export function getTradingAPI(pool: LPToken = LPToken.ZLP): TradingAPI {
    return SDK.getInstance().createAPI(
        NETWORK,
        getConnection(),
        ZO_API_ENDPOINT,
        HERMES_URL,
        pool,
    ) as TradingAPI;
}

export function getZLPAPIInstance(): TradingAPI {
    return getTradingAPI(LPToken.ZLP);
}

export function getSLPAPIInstance(): TradingAPI {
    return getTradingAPI(LPToken.SLP);
}

export function getUSDZAPIInstance(): TradingAPI {
    return getTradingAPI(LPToken.USDZ);
}

export function getZLPDataAPIInstance(): TradingDataAPI {
    return getZLPAPIInstance();
}

export function getSLPDataAPIInstance(): TradingDataAPI {
    return getSLPAPIInstance();
}

export function getUSDZDataAPIInstance(): TradingDataAPI {
    return getUSDZAPIInstance();
}

/** Resolve trading + data API for a pool (same instance: API extends DataAPI). */
export function getAPIAndDataAPI(pool: LPToken): {
    api: TradingAPI;
    dataAPI: TradingDataAPI;
} {
    const api = getTradingAPI(pool);
    return { api, dataAPI: api };
}

/** Simulate a PTB on gRPC (`simulateTransaction` replaces JSON-RPC dryRun). */
export async function simulateOrThrow(
    client: ZoSuiClient,
    tx: Transaction,
    label = 'transaction',
): Promise<void> {
    const result = await client.simulateTransaction({
        transaction: tx,
        include: { effects: true },
    });
    const executed = result.Transaction ?? result.FailedTransaction;
    const failed =
        result.$kind === 'FailedTransaction' ||
        executed?.status.success === false;
    if (failed) {
        const error =
            executed?.status && executed.status.success === false
                ? JSON.stringify(executed.status.error)
                : `${label} simulation failed`;
        console.error(`Failed to simulate ${label}: `, error);
        throw new Error(error);
    }
}

export async function signAndExecuteTx(
    client: ZoSuiClient,
    tx: Transaction,
    signer: Ed25519Keypair,
): Promise<{ digest?: string }> {
    const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        include: { effects: true },
    });
    const executed = res.Transaction ?? res.FailedTransaction;
    const digest = executed?.digest;
    if (digest) {
        await client.waitForTransaction({ digest });
    }
    const failed =
        res.$kind === 'FailedTransaction' ||
        executed?.status.success === false;
    if (failed) {
        const error =
            executed?.status && executed.status.success === false
                ? JSON.stringify(executed.status.error)
                : 'transaction execution failed';
        throw new Error(error);
    }
    return { digest };
}
