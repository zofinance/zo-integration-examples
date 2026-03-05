// SUI system object id
export const SUI_CLOCK_OBJECT_ID = '0x6';

// trade level constants
export const ALLOW_TRADE_NO_TRADE = 0;
export const ALLOW_TRADE_CAN_TRADE = 1;
export const ALLOW_TRADE_MUST_TRADE = 2;

export const getEnv = (key: string, defaultValue: string = ''): string => {
    return process.env[key] || defaultValue;
};

export const DEFAULT_SLIPPAGE = 0.003;
export const DEFAULT_RELAYER_FEE = 0.02;
