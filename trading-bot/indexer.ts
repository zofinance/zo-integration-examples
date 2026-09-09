import {
    LPToken,
    fetchAllTraderPositions,
    resolveTokenSymbol,
    type IBasePositionInfo,
    type IConsts,
    type ITraderPositionRecord,
} from '@zofai/zo-sdk';
import { ZO_API_ENDPOINT } from './connection';

export function positionRecordMatchesLp(
    record: ITraderPositionRecord,
    pool: LPToken,
    consts: IConsts,
): boolean {
    const core = pool === LPToken.SLP ? consts.sudoCore : consts.zoCore;
    const packageId = core.package.toLowerCase();
    const upgradedPackageId = core.upgradedPackage?.toLowerCase();
    const lpPool = String(pool).toLowerCase();
    const address = record.address?.trim().toLowerCase();
    const poolField = record.pool?.trim().toLowerCase();
    const addressMatches = Boolean(
        address &&
            (address === packageId ||
                (upgradedPackageId && address === upgradedPackageId)),
    );
    const poolMatches = Boolean(poolField && poolField === lpPool);
    return addressMatches || poolMatches;
}

function toNumber(value: string | number | null | undefined): number {
    if (value === null || value === undefined || value === '') {
        return 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Map a `/trader-positions` row to SDK position info (no RPC). */
export function traderRecordToPositionInfo(
    record: ITraderPositionRecord,
    consts: IConsts,
): IBasePositionInfo | null {
    if (!record.positionId) {
        return null;
    }
    const collateralToken = resolveTokenSymbol(
        record.collateralToken,
        null,
        consts,
    );
    const indexToken = resolveTokenSymbol(record.indexToken, null, consts);
    if (!collateralToken || !indexToken) {
        return null;
    }
    const openAmount = toNumber(record.openAmount);
    const decreaseAmount = toNumber(record.decreaseAmount);
    const remaining = Math.max(openAmount - decreaseAmount, 0);
    const openedMs = record.openedAt ? Date.parse(record.openedAt) : NaN;
    return {
        id: record.positionId,
        long: (record.direction?.toUpperCase() ?? 'LONG').includes('LONG'),
        owner: record.owner,
        version: 0,
        collateralToken,
        indexToken,
        collateralAmount: toNumber(record.collateralAmount),
        positionAmount: remaining || toNumber(record.positionSize),
        reservedAmount: toNumber(record.reserveAmount),
        positionSize: toNumber(record.positionSize) || remaining,
        lastFundingRate: 0,
        lastReservingRate: 0,
        reservingFeeAmount: 0,
        fundingFeeValue: 0,
        closed:
            record.closed === true ||
            record.status === 'CLOSED' ||
            record.status === 'LIQUIDATED',
        openTimestamp: Number.isFinite(openedMs)
            ? Math.floor(openedMs / 1000)
            : 0,
    };
}

export async function fetchTraderPositionsFromApi(
    owner: string,
    pool: LPToken,
    consts: IConsts,
    query: {
        status?: ITraderPositionRecord['status'];
        indexToken?: string;
        collateralToken?: string;
    } = {},
): Promise<IBasePositionInfo[]> {
    const records = await fetchAllTraderPositions(ZO_API_ENDPOINT, {
        owner,
        status: query.status,
        indexToken: query.indexToken,
        collateralToken: query.collateralToken,
    });
    return records
        .filter((record) => positionRecordMatchesLp(record, pool, consts))
        .map((record) => traderRecordToPositionInfo(record, consts))
        .filter((p): p is IBasePositionInfo => p != null);
}
