/**
 * unreachable-write — a write the story editor sent whose answer never came
 * back as the action's own, answered in the browser as a failed write.
 *
 * `serverAction()` throws, rather than answering, when the request never
 * completes, when an upstream answers with an error React Router did not
 * write (a bare 503), when the answer cannot be decoded, and when the action
 * itself failed on an exception. A throw from the client action reaches the
 * route's error card, and replaces the editor. These are answered instead as
 * `{ ok: false, reason: "unreachable" }`, carrying the write's intent and
 * nonce, so the field that made the write settles it as failed, keeps its
 * draft and offers Retry. An unreachable write is unconfirmed, not unwritten:
 * a transport failure can follow a commit.
 *
 * The action's own decisions keep their path: a redirect, and an error answer
 * below 500 (its refusals, 400, 401, 403, 404, 409), except 408 and 429,
 * which an upstream sends. The status is all that tells them apart once React
 * Router has built the error, so an upstream's other 4xx still reaches the
 * error card.
 *
 * The answer carries status 503 (`asUnreachableAnswer`). React Router reads
 * nothing again by default after an answer of 400 or more, for the page's
 * routes and for every fetcher's loaded data alike: during an outage the read
 * would fail too, and a loader's failure reaches the error card.
 *
 * @version v1.5.0-beta
 */

import { data, isRouteErrorResponse } from "react-router";

export interface UnreachableWrite {
  ok: false;
  reason: "unreachable";
  intent?: string;
  nonce?: string;
}

/** Whether a throw from `serverAction()` is a write that did not reach the action's own answer. */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof Response) return false;
  if (isRouteErrorResponse(error)) return error.status >= 500 || error.status === 408 || error.status === 429;
  return true;
}

/** Whether an action's answer is an unreachable write. */
export function isUnreachableAnswer(answer: unknown): answer is UnreachableWrite {
  return (
    typeof answer === "object" &&
    answer !== null &&
    (answer as { ok?: unknown }).ok === false &&
    (answer as { reason?: unknown }).reason === "unreachable"
  );
}

function formString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

/**
 * The action's answer, or an unreachable write's where `serverAction()` threw
 * one; anything else it threw is thrown on. The form is read from a copy of
 * the request, before the router sends the original.
 */
export async function answerOrUnreachable(request: Request, serverAction: () => Promise<unknown>): Promise<unknown> {
  const form = await request.clone().formData();
  try {
    return await serverAction();
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    const answer: UnreachableWrite = { ok: false, reason: "unreachable" };
    const intent = formString(form, "intent");
    const nonce = formString(form, "nonce");
    if (intent !== undefined) answer.intent = intent;
    if (nonce !== undefined) answer.nonce = nonce;
    return answer;
  }
}

/** The status an unreachable write is answered with. */
export const UNREACHABLE_STATUS = 503;

/**
 * An action's answer as the client action returns it: an unreachable write
 * with its status, so nothing is read again after it; any other as it is.
 */
export function asUnreachableAnswer<T>(answer: T): T | ReturnType<typeof data<T>> {
  return isUnreachableAnswer(answer) ? data(answer, { status: UNREACHABLE_STATUS }) : answer;
}

/**
 * The `shouldRevalidate` of every route whose loader runs on the story page:
 * another page is always read, and so is any read a submission starts. An
 * unreachable write's status holds back the router's default read, which is
 * right for the page the write was made on; but a navigation the write
 * overtakes would otherwise land on its address with the data of the page it
 * left (another story's steps, `_app`'s release state). That page's own reads
 * run instead, and fail as any read does during an outage.
 *
 * A change of the search alone on the same page is not read. No loader on the
 * story page reads `?step` or `?layer`, so choosing a step or opening a layer
 * panel would otherwise read the story again and dim the page under the
 * loading overlay. The one search value a loader reads is `?lng`, which the
 * root loader's locale detection takes.
 */
export function readAnotherPage({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: {
  currentUrl: URL;
  nextUrl: URL;
  formMethod?: string;
  defaultShouldRevalidate: boolean;
}): boolean {
  if (currentUrl.pathname !== nextUrl.pathname) return true;
  if (formMethod) return defaultShouldRevalidate;
  if (currentUrl.search === nextUrl.search) return defaultShouldRevalidate;
  return currentUrl.searchParams.get("lng") !== nextUrl.searchParams.get("lng");
}

/** The intent a submission names, or null when its body is not a form. */
async function requestIntent(request: Request): Promise<string | null> {
  try {
    const intent = (await request.clone().formData()).get("intent");
    return typeof intent === "string" ? intent : null;
  } catch {
    return null;
  }
}

/**
 * The client action of a route whose background reads are fetcher
 * submissions: a submission naming one of `readIntents` that fails in transit
 * is answered unreachable, with its intent and status 503, so the page that
 * asked keeps what it last showed and stays open. Any other intent reaches the
 * server action unchanged: those write, and what their failure means to the
 * author is not a read's answer.
 */
export async function answerReadsWhenUnreachable(
  request: Request,
  serverAction: () => Promise<unknown>,
  readIntents: readonly string[],
): Promise<unknown> {
  const intent = await requestIntent(request);
  if (intent === null || !readIntents.includes(intent)) return serverAction();
  return asUnreachableAnswer(await answerOrUnreachable(request, serverAction));
}

/**
 * A route's `clientAction` that answers `readIntents` unreachable where they
 * fail in transit (`answerReadsWhenUnreachable`) and passes every other intent
 * through.
 */
export function answerReadsClientAction(readIntents: readonly string[]) {
  return ({ request, serverAction }: { request: Request; serverAction: () => Promise<unknown> }) =>
    answerReadsWhenUnreachable(request, serverAction, readIntents);
}
