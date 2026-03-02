import { createDAppKit } from '@mysten/dapp-kit-react'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'

const GRPC_URLS = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: getJsonRpcFullnodeUrl('mainnet'),
}

export const dAppKit = createDAppKit({
  networks: ['mainnet'],
  createClient(network: 'mainnet' | 'testnet') {
    return new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] })
  },
})

// Global type registration required for dapp-kit hooks to work correctly
declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit
  }
}
