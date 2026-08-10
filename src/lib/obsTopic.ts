import { sha256 } from "js-sha256";

/**
 * Derive the Realtime topic name for the OBS relay channel.
 *
 * Security: we never put the raw API key into the channel topic, because
 * topic names are visible to subscribers and can be logged by realtime
 * infrastructure. Instead we use the SHA-256 hex digest of the key, which
 * the database RLS policy also computes so subscriptions remain owner-scoped.
 */
export function obsRelayTopic(apiKey: string): string {
  return `obs-relay-${sha256(apiKey.trim())}`;
}
