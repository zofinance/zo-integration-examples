import { SuiClient } from '@mysten/sui/client';
import { NETWORK } from './network';
import { ZLPAPI, Network, IBaseAPI, LPToken, SDKFactory, IZLPDataAPI, ISLPDataAPI, IUSDZDataAPI } from '@zofai/zo-sdk';

export function getConnection(): SuiClient {
    let rpcUrl: string;

    if (NETWORK === Network.MAINNET) {
        rpcUrl =
            process.env.SUI_MAINNET_RPC_URL ||
            'https://sui-mainnet-rpc.nodereal.io';
    } else if (NETWORK === Network.TESTNET) {
        rpcUrl =
            process.env.SUI_TESTNET_RPC_URL ||
            'https://sui-testnet-rpc.nodereal.io';
    } else {
        throw new Error(`unsupported network: ${NETWORK}`);
    }

    return new SuiClient({ url: rpcUrl });
}

export const ZO_API_ENDPOINT = 'https://api.zofinance.io'

// Get ZLP API instance using new SDK factory
export function getZLPAPIInstance(
  network: Network = Network.MAINNET,
  apiEndpoint = `${ZO_API_ENDPOINT}`,
  connectionURL = 'https://hermes.pyth.network',
): IBaseAPI {
  return SDKFactory.getInstance().createAPI(network, getConnection(), apiEndpoint, 'https://hermes.pyth.network', LPToken.ZLP)
}

// Get SLP API instance using new SDK factory
export function getSLPAPIInstance(
  network: Network = Network.MAINNET,
  apiEndpoint = `${ZO_API_ENDPOINT}`,
  connectionURL?: string,
): IBaseAPI {
  return SDKFactory.getInstance().createAPI(network, getConnection(), apiEndpoint, 'https://hermes.pyth.network', LPToken.SLP)
}

// Get USDZ API instance using new SDK factory
export function getUSDZAPIInstance(
  network: Network = Network.MAINNET,
  apiEndpoint = `${ZO_API_ENDPOINT}`,
  connectionURL?: string,
): IBaseAPI {
  return SDKFactory.getInstance().createAPI(network, getConnection(), apiEndpoint, 'https://hermes.pyth.network', LPToken.USDZ)
}


// Get ZLP DataAPI instance using new SDK factory
export function getZLPDataAPIInstance(
  network: Network = Network.MAINNET,
  apiEndpoint = `${ZO_API_ENDPOINT}`,
  connectionURL = 'https://hermes.pyth.network',
): IZLPDataAPI {
  return SDKFactory.getInstance().createZLPDataAPI(network, getConnection(), apiEndpoint, 'https://hermes.pyth.network')
}

// Get SLP DataAPI instance using new SDK factory
export function getSLPDataAPIInstance(
  network: Network = Network.MAINNET,
  apiEndpoint = `${ZO_API_ENDPOINT}`,
  connectionURL?: string,
): ISLPDataAPI {
  return SDKFactory.getInstance().createSLPDataAPI(network, getConnection(), apiEndpoint, 'https://hermes.pyth.network')
}

// Get USDZ DataAPI instance using new SDK factory
export function getUSDZDataAPIInstance(
  network: Network = Network.MAINNET,
  apiEndpoint = `${ZO_API_ENDPOINT}`,
  connectionURL?: string,
): IUSDZDataAPI {
  return SDKFactory.getInstance().createUSDZDataAPI(network, getConnection(), apiEndpoint, 'https://hermes.pyth.network')
}