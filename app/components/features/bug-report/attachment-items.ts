/**
 * This file lists what the bug-report panel shows the reporter it will
 * attach, one item per payload field, in the order the issue body writes
 * them.
 *
 * Each item's key is the one `buildIssueBody` reads from `removed`. Pinned
 * items render without a remove control: the post-crash error, and the
 * repository, which the body writes whatever the reporter removes.
 *
 * @version v1.5.0-beta
 */

import type { AttachmentItem } from "./AttachmentList";
import { errorItemKey, type CapturedError, type Payload } from "./build-issue-body";

export function buildAttachmentItems(
  payload: Payload | null,
  pinnedError: CapturedError | null | undefined,
  t: (key: string) => string,
): AttachmentItem[] {
  const items: AttachmentItem[] = [];
  if (pinnedError) {
    items.push({
      key: "__pinned",
      label: t("attach_item_recent_error"),
      value: pinnedError.message,
      pinned: true,
    });
  }
  if (!payload) return items;

  const push = (key: string, label: string, value: string | undefined, pinned?: boolean) => {
    if (value) items.push({ key, label: t(label), value, ...(pinned ? { pinned } : {}) });
  };
  const failure = payload.lastPublishFailure;

  items.push({ key: "url", label: t("attach_item_url"), value: payload.url });
  push("repository", "attach_item_repository", payload.repoFullName, true);
  push("githubName", "attach_item_github_name", payload.githubFullName);
  push("telarVersion", "attach_item_telar_version", payload.telarVersion);
  push(
    "headDiverged",
    "attach_item_head_diverged",
    payload.headDiverged ? t("attach_value_head_diverged") : undefined,
  );
  push(
    "buildSha",
    "attach_item_version",
    `${payload.buildSha} (${payload.environment})`,
  );
  items.push({ key: "browser", label: t("attach_item_browser"), value: payload.browser });
  items.push({ key: "viewport", label: t("attach_item_viewport"), value: payload.viewport });
  items.push({ key: "locale", label: t("attach_item_locale"), value: payload.locale });
  items.push({
    key: "timestamp",
    label: t("attach_item_reported_at"),
    value: payload.timestamp,
  });
  push(
    "lastPublishError",
    "attach_item_last_publish_error",
    failure
      ? `${failure.error} (${failure.at})`
      : undefined,
  );
  for (const [i, e] of payload.errors.entries()) {
    items.push({
      key: errorItemKey(i),
      label: t("attach_item_recent_error"),
      value: e.message,
    });
  }
  return items;
}
