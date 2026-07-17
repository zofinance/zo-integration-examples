import * as dotenv from 'dotenv';
import { Network } from '@zofai/zo-sdk';

dotenv.config();

export { Network };

export const NETWORK: Network =
    (process.env.NETWORK as Network) || Network.MAINNET;

console.log(`Using network: ${NETWORK}`);
