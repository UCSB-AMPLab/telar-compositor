import { describe, it, expect } from "vitest";
import { detectThemeAlert } from "../app/lib/theme-recognition";

describe("detectThemeAlert", () => {
  it("returns showAlert:false when themeValue is empty AND themes is empty (suppression edge — ThemeSwatches carries the empty-state copy)", () => {
    const result = detectThemeAlert({ themeValue: "", themes: [] });
    expect(result).toEqual({
      showAlert: false,
      isEmpty: true,
      isUnrecognised: false,
    });
  });

  it("returns showAlert:true with isEmpty:true when themeValue is empty AND themes is non-empty (empty-case alert)", () => {
    const result = detectThemeAlert({
      themeValue: "",
      themes: [{ theme_id: "trama" }],
    });
    expect(result).toEqual({
      showAlert: true,
      isEmpty: true,
      isUnrecognised: false,
    });
  });

  it("returns showAlert:false when themeValue matches an imported theme_id (recognised case)", () => {
    const result = detectThemeAlert({
      themeValue: "trama",
      themes: [{ theme_id: "trama" }],
    });
    expect(result).toEqual({
      showAlert: false,
      isEmpty: false,
      isUnrecognised: false,
    });
  });

  it("returns showAlert:true with isUnrecognised:true when themeValue does not match any imported theme_id (mismatch-case alert)", () => {
    const result = detectThemeAlert({
      themeValue: "trama-2",
      themes: [{ theme_id: "trama" }],
    });
    expect(result).toEqual({
      showAlert: true,
      isEmpty: false,
      isUnrecognised: true,
    });
  });

  it("treats themeValue === null the same as empty string (defensive null-coalesce)", () => {
    const result = detectThemeAlert({
      themeValue: null,
      themes: [{ theme_id: "trama" }],
    });
    expect(result).toEqual({
      showAlert: true,
      isEmpty: true,
      isUnrecognised: false,
    });
  });

  it("treats themeValue === undefined the same as empty string (defensive null-coalesce)", () => {
    const result = detectThemeAlert({
      themeValue: undefined,
      themes: [{ theme_id: "trama" }],
    });
    expect(result).toEqual({
      showAlert: true,
      isEmpty: true,
      isUnrecognised: false,
    });
  });
});
