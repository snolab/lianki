// Framework-agnostic API-token shape. Extracted from lib/getApiTokensCollection.ts
// (which imports the MongoDB client) so the D1 repos / CF-native worker can import
// it without pulling MongoDB. getApiTokensCollection re-exports it.
export type ApiToken = {
  tokenHash: string;
  email: string;
  name: string;
  createdAt: Date;
};
