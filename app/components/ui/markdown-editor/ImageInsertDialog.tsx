/**
 * ImageInsertDialog — two-tab modal dialog for image insertion in the MarkdownEditor.
 *
 * URL tab: accepts an image URL + alt text and inserts ![alt](url).
 * Objects tab: grid of imported project objects; clicking one inserts its image.
 * That is the stored thumbnail, else the first canvas image of the object's
 * manifest, else an image built from its IIIF info.json. A manifest with more
 * than one canvas, or whose first canvas is a PDF, is refused as a multi-page
 * document, an object with no image found shows an error, and a lookup that
 * finishes after the dialog closed, the tab changed or another object was
 * chosen inserts nothing.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import { isExternalSource, siteIiifObjectBase } from "~/lib/object-id";
import { externalObjectImage, MULTI_PAGE, selfHostedObjectImage, type ObjectImage } from "~/lib/iiif-insert-image";

/**
 * An object the dialog offers. `source_url` decides where its image is read
 * from: an external object's is its stored thumbnail, else the image its
 * manifest or info.json names; a self-hosted object's is under the site's
 * tiles.
 */
interface InsertableObject {
  object_id: string;
  title: string | null;
  thumbnail: string | null;
  image_available?: boolean | null;
  alt_text?: string | null;
  source_url: string | null;
}

interface ImageInsertDialogProps {
  open: boolean;
  onClose: () => void;
  onInsert: (url: string, alt: string) => void;
  objects: InsertableObject[];
  siteBaseUrl?: string | null;
  /** The site's `telar_version`, which decides the id its tiles are under. */
  frameworkVersion?: string | null;
}

type ActiveTab = "url" | "objects";

/**
 * Where a self-hosted object's tiles are on the site, under its site id; null
 * for an external object, whose image is its stored thumbnail, and for a site
 * with no base yet.
 */
function selfHostedBase(
  obj: InsertableObject,
  siteBaseUrl: string | null | undefined,
  frameworkVersion: string | null | undefined,
): string | null {
  if (!siteBaseUrl || isExternalSource(obj.source_url)) return null;
  return siteIiifObjectBase(siteBaseUrl.replace(/\/+$/, ""), obj.object_id, frameworkVersion);
}

/**
 * An object's image: an external object's stored thumbnail, else the image
 * its source names; a self-hosted object's, under the site's tiles. Null when
 * there is none to read.
 */
async function objectImage(obj: InsertableObject, base: string | null): Promise<ObjectImage> {
  if (base) return selfHostedObjectImage(base, obj.image_available !== false);
  if (obj.thumbnail) return obj.thumbnail;
  return obj.source_url && isExternalSource(obj.source_url) ? externalObjectImage(obj.source_url) : null;
}

export function ImageInsertDialog({ open, onClose, onInsert, objects, siteBaseUrl, frameworkVersion }: ImageInsertDialogProps) {
  const { t } = useTranslation("editor");
  const [activeTab, setActiveTab] = useState<ActiveTab>("url");
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");

  function handleInsertUrl() {
    if (!url.trim()) return;
    onInsert(url.trim(), alt.trim());
    onClose();
  }

  const [insertError, setInsertError] = useState<string | null>(null);

  // The latest object choice. A lookup that resolves after the dialog closed,
  // or after another object was chosen, is no longer the author's choice and
  // must not insert.
  const choice = useRef(0);
  useEffect(() => {
    if (!open) choice.current += 1;
  }, [open]);

  async function handleInsertObject(obj: InsertableObject) {
    const token = ++choice.current;
    setInsertError(null);
    const image = await objectImage(obj, selfHostedBase(obj, siteBaseUrl, frameworkVersion));
    if (token !== choice.current) return;
    if (image === MULTI_PAGE) {
      setInsertError(t("image_dialog.pdf_not_supported"));
      return;
    }
    // An empty address would erase a carousel image or insert `![alt]()`.
    if (!image) {
      setInsertError(t("image_dialog.image_not_found"));
      return;
    }
    onInsert(image, obj.alt_text || obj.title || obj.object_id);
    onClose();
  }

  // Leaving the objects tab withdraws the object choice, as closing does.
  function selectTab(tab: ActiveTab) {
    if (tab !== activeTab) choice.current += 1;
    setActiveTab(tab);
  }

  function handleClose() {
    choice.current += 1;
    setUrl("");
    setAlt("");
    setActiveTab("url");
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} className="max-w-2xl">
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">
        {t("image_dialog.title")}
      </h2>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 mb-4">
        <button
          type="button"
          onClick={() => selectTab("url")}
          className={`font-heading text-sm px-4 py-2 -mb-px border-b-2 transition-colors ${
            activeTab === "url"
              ? "border-anil text-charcoal"
              : "border-transparent text-gray-400 hover:text-charcoal"
          }`}
        >
          {t("image_dialog.tab_url")}
        </button>
        <button
          type="button"
          onClick={() => selectTab("objects")}
          className={`font-heading text-sm px-4 py-2 -mb-px border-b-2 transition-colors ${
            activeTab === "objects"
              ? "border-anil text-charcoal"
              : "border-transparent text-gray-400 hover:text-charcoal"
          }`}
        >
          {t("image_dialog.tab_objects")}
        </button>
      </div>

      {/* URL tab */}
      {activeTab === "url" && (
        <div className="space-y-3">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("image_dialog.url_placeholder")}
            className="w-full font-body text-sm border border-gray-200 rounded px-3 py-2 focus:border-anil"
          />
          <input
            type="text"
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            placeholder={t("image_dialog.alt_placeholder")}
            className="w-full font-body text-sm border border-gray-200 rounded px-3 py-2 focus:border-anil"
          />
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 font-body text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            >
              {t("image_dialog.cancel")}
            </button>
            <button
              type="button"
              onClick={handleInsertUrl}
              disabled={!url.trim()}
              className="px-4 py-2 bg-terracotta text-cream font-body font-medium text-sm rounded-md hover:bg-terracotta/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t("image_dialog.insert")}
            </button>
          </div>
        </div>
      )}

      {/* Objects tab */}
      {activeTab === "objects" && (
        <div>
          {insertError && (
            <p className="font-body text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">{insertError}</p>
          )}
          {objects.length === 0 ? (
            <p className="font-body text-sm text-gray-400 text-center py-8">
              {t("image_dialog.no_objects")}
            </p>
          ) : (
            <div className="grid grid-cols-4 gap-2 max-h-80 overflow-y-auto">
              {objects.map((obj) => (
                <button
                  key={obj.object_id}
                  type="button"
                  onClick={() => handleInsertObject(obj)}
                  className="group flex flex-col items-center gap-1 p-1 rounded-md hover:bg-cream-dark transition-colors text-left"
                >
                  {obj.thumbnail && obj.image_available !== false ? (
                    <img
                      src={obj.thumbnail}
                      alt={obj.title ?? t("common:untitled")}
                      className="w-full aspect-square object-cover rounded"
                    />
                  ) : (
                    <div className="w-full aspect-square bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs text-center p-1">
                      {obj.title ?? t("common:untitled")}
                    </div>
                  )}
                  <span className="font-body text-xs text-charcoal truncate w-full text-center">
                    {obj.title ?? t("common:untitled")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
