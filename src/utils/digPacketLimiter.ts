/**
 * Shared PLAYER_DIGGING rate limiter.
 *
 * The server observed in testing allows at most 40 PLAYER_DIGGING packets per
 * 500 ms. We deliberately stay well below that ceiling instead of trying to
 * evade the detector. One packet every 17 ms targets ~29-30 packets/500 ms
 * per bot and serializes packets from all mining features.
 */
let PACKET_INTERVAL_MS = 17;

export function getPacketIntervalMs(): number {
  return PACKET_INTERVAL_MS;
}

export function setPacketIntervalMs(ms: number): number {
  PACKET_INTERVAL_MS = Math.max(1, Math.floor(ms));
  return PACKET_INTERVAL_MS;
}

type ClientLike = { write: (name: string, payload: any) => void };

type QueueState = {
  tail: Promise<void>;
  lastSentAt: number;
};

const states = new WeakMap<object, QueueState>();

function getState(client: object): QueueState {
  let state = states.get(client);
  if (!state) {
    state = { tail: Promise.resolve(), lastSentAt: 0 };
    states.set(client, state);
  }
  return state;
}

export function queueBlockDig(
  client: ClientLike,
  status: string | number,
  position: { x: number; y: number; z: number },
  face = 1,
  sequence = 0,
): Promise<void> {
  const state = getState(client as object);

  state.tail = state.tail.then(async () => {
    const elapsed = Date.now() - state.lastSentAt;
    const wait = PACKET_INTERVAL_MS - elapsed;
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }

    try {
      client.write("block_dig", {
        status,
        location: { x: position.x, y: position.y, z: position.z },
        face,
        sequence,
      });
      state.lastSentAt = Date.now();
    } catch {
      // Connection may have closed between queueing and sending.
      state.lastSentAt = Date.now();
    }
  });

  return state.tail;
}
