import { getConsts, LPToken } from '@zofai/zo-sdk';
import { NETWORK } from './network';

/** Default consts (ZLP). Prefer `getDeployments(pool)` when trading a specific pool. */
export const deployments = getConsts(NETWORK, LPToken.ZLP);

export function getDeployments(pool: LPToken = LPToken.ZLP) {
    return getConsts(NETWORK, pool);
}
