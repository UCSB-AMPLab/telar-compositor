/**
 * The objects a story editor offers, read from the collaborative document.
 *
 * The route's loader reads the objects once, when the editor opens. Objects
 * added or deleted afterwards, by this user or a collaborator, arrive over the
 * socket into the document's `objects` array, so the editor reads that array
 * once the document has synced, and the loader's rows plus whatever the
 * document already holds until then.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { compareByOrderKey, readOrderKey } from "./field-order";

/** The columns of an object the editor's picker, viewer and image dialog read. */
export interface EditorObject {
  object_id: string;
  title: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
  source_url: string | null;
  alt_text: string | null;
}

function scalar(yMap: Y.Map<unknown>, key: string): string | null {
  const value = yMap.get(key);
  if (value instanceof Y.Text) return value.length === 0 ? null : value.toString();
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One document object as the editor reads it. */
export function editorObjectFromYMap(yMap: Y.Map<unknown>, yIndex: number) {
  return {
    object_id: typeof yMap.get("object_id") === "string" ? (yMap.get("object_id") as string) : "",
    title: scalar(yMap, "title"),
    thumbnail: scalar(yMap, "thumbnail"),
    image_available: Boolean(yMap.get("image_available") ?? false),
    source_url: scalar(yMap, "source_url"),
    alt_text: scalar(yMap, "alt_text"),
    _validationState: (yMap.get("_validation_state") as string | null) ?? null,
    _orderKey: readOrderKey(yMap),
    _yIndex: yIndex,
  };
}

export type DocEditorObject = ReturnType<typeof editorObjectFromYMap>;

function offered(o: DocEditorObject): EditorObject {
  const { object_id, title, thumbnail, image_available, source_url, alt_text } = o;
  return { object_id, title, thumbnail, image_available, source_url, alt_text };
}

function usableInOrder(docObjects: readonly DocEditorObject[]): DocEditorObject[] {
  return [...docObjects]
    .sort(compareByOrderKey)
    .filter((o) => o._validationState !== "error" && o.object_id !== "");
}

/**
 * The objects the editor offers. Once the document has synced they are the
 * document's, in the order a publish writes them, even when it holds none: an
 * object deleted since the loader read is gone. Before then the shared arrays
 * may not have filled, so the loader's rows are offered, each replaced by the
 * document's copy when it holds one, followed by any object only the document
 * holds (added on this device before the first sync). An object whose manifest
 * failed validation is left out, as the objects page marks it unusable.
 */
export function liveEditorObjects<T extends EditorObject>(
  loaderObjects: readonly T[],
  docObjects: readonly DocEditorObject[] | null,
  synced: boolean,
): Array<EditorObject> {
  if (docObjects === null) return [...loaderObjects];
  const usable = usableInOrder(docObjects);
  if (synced) return usable.map(offered);
  const inDoc = new Map(usable.map((o) => [o.object_id, o]));
  const loaded = new Set(loaderObjects.map((o) => o.object_id));
  const fromLoader = loaderObjects.map((o) => {
    const live = inDoc.get(o.object_id);
    return live ? offered(live) : o;
  });
  return [...fromLoader, ...usable.filter((o) => !loaded.has(o.object_id)).map(offered)];
}
