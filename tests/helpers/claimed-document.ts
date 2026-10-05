/**
 * Put a Durable Object instance into the state a completed load leaves it in.
 *
 * A load that opens a document also claims the row it loaded from: it holds
 * the revision it claimed and the sequence its base was tagged with, and every
 * write it makes afterwards is conditioned on that revision. A test that only
 * sets `docLoaded` plants a state no load can produce, and the snapshot refuses
 * it — there is no revision to condition a write on.
 *
 * @version v1.5.0-beta
 */

/**
 * The default revision is 1, not 0: a completed load has moved the row's
 * revision at least once, because the claim is what makes the load a completed
 * one. Revision 0 is the state of a row no instance has ever claimed, so
 * planting it here would describe a load that never happened.
 */
export function markLoaded(instance: unknown, revision = 1, seq = 0): void {
  Object.assign(instance as object, {
    docLoaded: true,
    docWrite: revision,
    docSeq: seq,
  });
}
