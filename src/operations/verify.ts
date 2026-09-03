/**
 * Verified writes — the one place that decides whether a write LANDED.
 *
 * A 200 from Planka proves that the request was accepted, not that the change
 * is in the database: `PATCH /api/cards/:id {isSubscribed:true}` answers 200
 * with `isSubscribed: null`, and a `DELETE` that returns the deleted item is
 * still worth re-reading. So every write in this server writes, re-reads, and
 * reports what the re-read says — never what was asked for.
 *
 * The pattern was written twice by hand (setCardLabels, add_attachment); this
 * module is that pattern, once.
 */
import { PlankaError } from "../errors.js";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface VerifiedWriteResult<T, A> {
  /** Whatever the write returned (usually Planka's `item`). */
  result: T;
  /** True only when the re-read confirmed the change. */
  verified: boolean;
  /** The re-read state, when the re-read succeeded. */
  after?: A;
  /** Set when the re-read itself blew up — the write may or may not have landed. */
  verificationError?: string;
}

/**
 * Run a write, re-read the entity, and report whether the change is really there.
 *
 * `landed` gets the re-read state and the write's own result; it answers the
 * only question that matters: is what we asked for true now?
 */
export async function verifiedWrite<T, A>(opts: {
  write: () => Promise<T>;
  reread: (written: T) => Promise<A>;
  landed: (after: A, written: T) => boolean;
}): Promise<VerifiedWriteResult<T, A>> {
  const result = await opts.write();

  let after: A;
  try {
    after = await opts.reread(result);
  } catch (error) {
    return {
      result,
      verified: false,
      verificationError: `the write was sent but could not be re-read: ${describe(error)}`,
    };
  }

  return { result, verified: opts.landed(after, result), after };
}

export interface VerifiedDeleteResult<T> {
  /** The DELETE response body (Planka 2.x returns the deleted item). */
  result: T;
  /** True only when a re-read confirmed the entity is gone. */
  verified: boolean;
  /** Set when the confirmation could not be made at all. */
  verificationError?: string;
  /** Set when confirmation was structurally impossible (missing parent id). */
  verificationUnavailable?: string;
}

/**
 * Run a delete and confirm the entity is really gone.
 *
 * `confirmGone` returns true (gone), false (still there) or null (could not
 * check — e.g. the parent id needed for the re-read is unknown).
 */
export async function verifiedDelete<T>(opts: {
  del: () => Promise<T>;
  confirmGone: (deleted: T) => Promise<boolean | null>;
  /** Message used when confirmGone answers null. */
  unknownReason?: string;
}): Promise<VerifiedDeleteResult<T>> {
  const result = await opts.del();

  let gone: boolean | null;
  try {
    gone = await opts.confirmGone(result);
  } catch (error) {
    return {
      result,
      verified: false,
      verificationError: `the delete was sent but could not be confirmed: ${describe(error)}`,
    };
  }

  if (gone === null) {
    return {
      result,
      verified: false,
      verificationUnavailable:
        opts.unknownReason ?? "the entity's parent is unknown, so the delete could not be confirmed",
    };
  }

  return { result, verified: gone };
}

/**
 * Confirmation helper for entities that have their own GET: a 404 on re-read
 * is the proof of deletion. Any other failure propagates.
 */
export async function goneOn404(reread: () => Promise<unknown>): Promise<boolean> {
  try {
    await reread();
    return false;
  } catch (error) {
    if (error instanceof PlankaError && error.status === 404) return true;
    throw error;
  }
}

/**
 * Standard tool payload for a write.
 *
 * - verified            → success, no isError
 * - unavailable         → not an error, but `verified: false` and the reason
 * - anything else       → isError, because the write cannot be claimed
 */
export function writeResult(
  payload: Record<string, unknown>,
  v: {
    verified: boolean;
    verificationError?: string;
    verificationUnavailable?: string;
  }
) {
  const soft = !v.verified && !v.verificationError && v.verificationUnavailable;
  const body: Record<string, unknown> = {
    success: v.verified || Boolean(soft),
    verified: v.verified,
    ...(v.verificationError ? { verificationError: v.verificationError } : {}),
    ...(v.verificationUnavailable && !v.verificationError
      ? { verificationUnavailable: v.verificationUnavailable }
      : {}),
    ...payload,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    ...(v.verified || soft ? {} : { isError: true as const }),
  };
}

/**
 * The "nothing to do" guard shared by the update tools: a PATCH with only an
 * id is a no-op that Planka happily answers 200 to.
 */
export function nothingToDo(fields: string, extra?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: nothing to do — pass at least one field to change (${fields}).${extra ? ` ${extra}` : ""}`,
      },
    ],
    isError: true as const,
  };
}
