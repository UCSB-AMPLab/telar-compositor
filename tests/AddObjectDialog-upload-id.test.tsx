// @vitest-environment jsdom
/**
 * The Upload tab shows the ID a new object will use before it is submitted.
 * The field takes only the characters the server keeps, a line under it says
 * the ID becomes the page address and image file name, and the ID submitted is
 * the ID shown.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AddObjectDialog } from "~/components/features/objects/AddObjectDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { id?: string }) =>
      key === "upload_object_id_help" ? `help:${options?.id}` : key,
  }),
}));

function props(onUploadConfirm: (payloads: { objectId: string }[]) => void) {
  return {
    open: true,
    onClose: vi.fn(),
    projectId: 1,
    canUpload: true,
    uploadDisabledReason: null,
    fetchResult: null,
    onFetchUrl: vi.fn(),
    onIiifConfirm: vi.fn(),
    isFetching: false,
    onUploadConfirm,
    isUploading: false,
    uploadError: null,
    existingObjectIds: [],
    onExternalConfirm: vi.fn(),
    isAdding: false,
  };
}

/** Open the Upload tab and drop one file, landing on the details step. */
function stageFile(onUploadConfirm: (payloads: { objectId: string }[]) => void, name = "Mission Bell.jpg") {
  render(
    <MemoryRouter>
      <AddObjectDialog {...props(onUploadConfirm)} />
    </MemoryRouter>
  );
  const tab = screen.getAllByText("tab_upload").find((el) => el.tagName === "BUTTON");
  fireEvent.click(tab!);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["x"], name, { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });
  return screen.getByLabelText("upload_object_id") as HTMLInputElement;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddObjectDialog — the new object's ID", () => {
  it("shows the ID made from the file name, with the line saying where it is used", () => {
    const field = stageFile(vi.fn());
    expect(field.value).toBe("mission-bell");
    expect(screen.getByText("help:mission-bell")).toBeTruthy();
  });

  it("keeps only the characters the server keeps while typing", () => {
    const field = stageFile(vi.fn());
    fireEvent.change(field, { target: { value: "Mapa de Santafé #2!" } });
    expect(field.value).toBe("mapa-de-santafe-2");
    expect(screen.getByText("help:mapa-de-santafe-2")).toBeTruthy();
  });

  it("submits the ID that is shown", () => {
    const onUploadConfirm = vi.fn();
    const field = stageFile(onUploadConfirm);
    fireEvent.change(field, { target: { value: "My Map_2 -" } });
    const shown = screen.getByText(/^help:/).textContent!.replace("help:", "");
    fireEvent.click(screen.getByText("upload_confirm"));
    expect(onUploadConfirm).toHaveBeenCalledTimes(1);
    expect(onUploadConfirm.mock.calls[0][0][0].objectId).toBe(shown);
    expect(shown).toBe("my-map-2");
  });

  it("shows the ID the title makes while the field is empty, and submits that one", () => {
    const onUploadConfirm = vi.fn();
    const field = stageFile(onUploadConfirm);
    fireEvent.change(field, { target: { value: "" } });
    expect(screen.getByText("help:mission-bell")).toBeTruthy();
    fireEvent.click(screen.getByText("upload_confirm"));
    expect(onUploadConfirm.mock.calls[0][0][0].objectId).toBe("mission-bell");
  });
});
