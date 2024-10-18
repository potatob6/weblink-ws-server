export type SessionID = string;
export type ClientID = string;

export interface Client {
  clientId: ClientID;
  name: string;
  avatar: string | null;
}
export type TransferClient = Client & {
  createdAt: number;
  resume?: boolean;
};

export interface RawSignal {
  type: string;
  data: any;
}

export interface ClientSignal extends RawSignal {
  sessionId: SessionID;
  clientId: ClientID;
  targetClientId: ClientID;
}
