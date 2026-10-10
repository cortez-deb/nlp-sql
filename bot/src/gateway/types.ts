export interface InboundMessage {
  id: string;
  dedupeKey: string;
  chatId: string;
  senderId: string;
  senderPhone?: string; // digits only
  text: string;
  isGroup: boolean;
  fromMe: boolean;
  type: string;
  timestampMs: number;
}

export type ParseResult =
  | { kind: 'message'; msg: InboundMessage }
  | { kind: 'ignore' } // valid delivery we do not act on (other event/session/type)
  | { kind: 'reject'; status: 400 | 401 }; // bad signature or malformed body

export interface GatewayAdapter {
  parse(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): ParseResult; // verifies + parses; never throws
  sendText(chatId: string, text: string): Promise<void>; // chunks > 3800 chars
  sendTyping?(chatId: string, state: 'typing' | 'paused'): Promise<void>;
}

export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
