import { getConnection } from '../connection';
import { getPositionCaps } from '../position';

async function main() {
    const client = getConnection();
    const positions = await getPositionCaps(
        client,
        '0xe639ca99089440862b43924ba95db698cbed1bd8536ac8a0c61d25184958cd96',
    );
    console.log(positions);
}

main();
