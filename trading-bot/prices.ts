import type { TradingAPI } from './connection';

/**
 * USD price from zo-sdk Pyth Pro (`getLatestPythProPricesForTokens`).
 * Falls back to Binance if Kronos has no feed for the token.
 */
export async function fetchTokenUsdPrice(
    api: TradingAPI,
    token: string,
): Promise<number> {
    try {
        const feedIds = api.resolveLazerFeedIdsForTokens([token]);
        const data = await api.getLatestPythProPricesForTokens([token]);
        const expectedId = feedIds[0];
        const feed =
            (expectedId != null
                ? data.priceFeeds.find((f) => f.priceFeedId === expectedId)
                : undefined) ?? data.priceFeeds[0];
        if (feed?.priceUsd && Number.isFinite(feed.priceUsd) && feed.priceUsd > 0) {
            return feed.priceUsd;
        }
    } catch (error) {
        console.warn(`Pyth Pro price failed for ${token}, falling back to Binance:`, error);
    }

    const parsedToken = token === 'nusdc' ? 'usdc' : token;
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${parsedToken.toUpperCase()}USDT`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch price for ${token}: HTTP ${response.status}`);
    }
    const body = await response.json();
    const price = parseFloat(body?.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price for ${token}`);
    }
    return price;
}
