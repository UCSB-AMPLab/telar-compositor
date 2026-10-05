/**
 * The objects sync readers read objects.csv strictly, at the head they resolve,
 * `getFileAtRef(..., { strict: true })`. Cases that state the
 * repository's current files through `getFileContent` answer that read from
 * it, so one stand-in keeps serving the repository while reads at the three-way
 * base, named by `isBaseRef`, keep their own stand-in. A null file is absent.
 *
 * @version v1.5.0-beta
 */

// biome-ignore lint/suspicious/noExplicitAny: a stand-in of any reader's shape
type Read = (...args: any[]) => Promise<any>;

export function strictReadsFromFileContent(getFileContent: Read, other: Read, isBaseRef?: (ref: string) => boolean) {
  return async (...args: unknown[]) => {
    const options = args[5] as { strict?: boolean } | undefined;
    // The three-way base is read strictly too, so a case with a base names its
    // ref, and reads at it keep the base's own stand-in.
    if (!options?.strict || isBaseRef?.(args[4] as string)) return other(...args);
    // Without the ref: the case states the repository's current files there.
    const content = await getFileContent(...args.slice(0, 4));
    return content == null ? { status: "absent" } : { status: "ok", content };
  };
}
