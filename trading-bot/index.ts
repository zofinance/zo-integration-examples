import dotenv from 'dotenv';
import { TradeConfig, tradeWithMarketOrder, tradeWithTPSL } from './trade';
import { LPToken } from 'zo-sdk';
dotenv.config();

async function main() {
    const btcConfig: TradeConfig = {
        indexToken: 'btc',
        collateralToken: 'nusdc',
        long: true,
        // Instead of fixed size, use a size range
        minSize: BigInt(500000), // 0.005 BTC minimum
        maxSize: BigInt(1500000), // 0.015 BTC maximum
        collateralAmount: BigInt(50000000), // 50 USD
        takeProfitPercentage: 0.5, // 0.5% take profit
        stopLossPercentage: 0.5, // 0.5% stop loss
        tradeInterval: 5000,
        createOpposite: true, // Enable creating opposite position
        tradeMode: 'Market',
        pool: LPToken.USDZ,
    };

    if (btcConfig.tradeMode === 'TPSL') {
        await tradeWithTPSL(btcConfig);
    } else {
        await tradeWithMarketOrder(btcConfig);
    }
}

if (require.main === module) {
    main().catch(console.error);
}
