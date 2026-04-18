/**
 * ImageInsertDialog — two-tab modal dialog for image insertion in the MarkdownEditor.
 *
 * URL tab: accepts an image URL + alt text and inserts ![alt](url).
 * Objects tab: grid of imported project objects; clicking one inserts its thumbnail URL.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";

interface ImageInsertDialogProps {
  open: boolean;
  onClose: () => void;
  onInsert: (url: string, alt: string) => void;
  objects: Array<{ object_id: string; title: string | null; thumbnail: string | null; image_available?: boolean | null; alt_text?: string | null }>;
  siteBaseUrl?: string | null;
}

type ActiveTab = "url" | "objects";

export function ImageInsertDialog({ open, onClose, onInsert, objects, siteBaseUrl }: ImageInsertDialogProps) {
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

  async function handleInsertObject(obj: { object_id: string; title: string | null; thumbnail: string | null; alt_text?: string | null }) {
    setInsertError(null);
    const altText = obj.alt_text || obj.title || obj.object_id;
    if (!siteBaseUrl) {
      onInsert(obj.thumbnail ?? "", altText);
      onClose();
      return;
    }
    const base = siteBaseUrl.replace(/\/+$/, "");
    // Fetch the manifest to get the actual image body URL
    try {
      const res = await fetch(`${base}/iiif/objects/${obj.object_id}/manifest.json`);
      if (res.ok) {
        type IiifManifestPage = { items?: Array<{ items?: Array<{ body?: { id?: string; format?: string } }> }> };
        const manifest = await res.json() as { items?: IiifManifestPage[] };
        // Reject multi-page documents (PDFs) — they can't be inserted as images
        const pages = manifest?.items ?? [];
        if (pages.length > 1) {
          setInsertError(t("image_dialog.pdf_not_supported"));
          return;
        }
        const body = pages[0]?.items?.[0]?.items?.[0]?.body;
        const format = body?.format ?? "";
        if (format === "application/pdf") {
          setInsertError(t("image_dialog.pdf_not_supported"));
          return;
        }
        const bodyId = body?.id;
        if (bodyId) {
          onInsert(bodyId, altText);
          onClose();
          return;
        }
      }
    } catch {
      // Fall through to default
    }
    // Fallback: page-1 pattern
    onInsert(`${base}/iiif/objects/${obj.object_id}/page-1/full/max/0/default.jpg`, altText);
    onClose();
  }

  function handleClose() {
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
          onClick={() => setActiveTab("url")}
          className={`font-heading text-sm px-4 py-2 -mb-px border-b-2 transition-colors ${
            activeTab === "url"
              ? "border-periwinkle text-charcoal"
              : "border-transparent text-gray-400 hover:text-charcoal"
          }`}
        >
          {t("image_dialog.tab_url")}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("objects")}
          className={`font-heading text-sm px-4 py-2 -mb-px border-b-2 transition-colors ${
            activeTab === "objects"
              ? "border-periwinkle text-charcoal"
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
            className="w-full font-body text-sm border border-gray-200 rounded px-3 py-2 focus:outline-none focus:border-periwinkle"
          />
          <input
            type="text"
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            placeholder={t("image_dialog.alt_placeholder")}
            className="w-full font-body text-sm border border-gray-200 rounded px-3 py-2 focus:outline-none focus:border-periwinkle"
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
                      alt={obj.title ?? obj.object_id}
                      className="w-full aspect-square object-cover rounded"
                    />
                  ) : (
                    <div className="w-full aspect-square bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs text-center p-1">
                      {obj.title ?? obj.object_id}
                    </div>
                  )}
                  <span className="font-body text-xs text-charcoal truncate w-full text-center">
                    {obj.title ?? obj.object_id}
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
