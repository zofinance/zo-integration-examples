import { NETWORK } from './network';
import { getConsts } from 'zo-sdk';

export const deployments = getConsts(NETWORK.valueOf());
