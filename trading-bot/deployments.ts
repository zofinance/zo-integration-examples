import { NETWORK } from './network';
import { getConsts } from '@zofai/zo-sdk';

export const deployments = getConsts(NETWORK.valueOf());
