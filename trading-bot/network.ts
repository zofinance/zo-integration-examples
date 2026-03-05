import * as dotenv from 'dotenv';

dotenv.config();

export enum Network {
    MAINNET = 'mainnet',
    TESTNET = 'testnet',
    DEVNET = 'devnet',
    LOCALNET = 'localnet',
}

export const NETWORK: Network =
    (process.env.NETWORK as Network) || Network.MAINNET;

console.log(`Using network: ${NETWORK}`);
