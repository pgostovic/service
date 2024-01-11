interface ApiMessage {
  payload: unknown;
}

export interface ApiRequestMessage extends ApiMessage {
  domain: string;
  method: string;
}

export interface ApiResponseMessage extends ApiMessage {
  stats: unknown;
}

export interface ApiNotificationMessage extends ApiMessage {
  /**
   * For now, this is the id of the WebSocket connection to send the notification to.
   * This attribute can be generalized to support other types of recipients, like:
   * - identity: the user's identity (i.e. via authentication)
   * - subscription: the key for a subscription (i.e. via pub/sub)
   */
  recipient: { id: string };
}

export interface NotifyApi {
  notify: (msg: ApiNotificationMessage) => Promise<void>;
}
