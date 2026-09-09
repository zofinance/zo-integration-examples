import { createDAppKit } from '@mysten/dapp-kit-react'
import { SuiGrpcClient } from '@mysten/sui/grpc'

const GRPC_URLS = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
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
