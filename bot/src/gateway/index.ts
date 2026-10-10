import type { BotConfig } from '../config';
import { OpenWAGatewayAdapter } from './openwa';
import { GatewayAdapter } from './types';
import { WAAutomateGatewayAdapter } from './waAutomate';

export * from './types';
export * from './signature';
export { OpenWAGatewayAdapter } from './openwa';
export { WAAutomateGatewayAdapter } from './waAutomate';

export function createGateway(config: BotConfig): GatewayAdapter {
  if (config.OPENWA_FLAVOR === 'openwa-gateway') {
    return new OpenWAGatewayAdapter(config);
  }
  return new WAAutomateGatewayAdapter(config);
}
