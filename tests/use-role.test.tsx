// @vitest-environment jsdom

/**
 * use-role — coverage for the typed loader-read hooks that form the
 * don't-render contract. useRole() reads userRole from the routes/_app loader;
 * useIsConvenor() narrows it to a boolean.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useRole, useIsConvenor } from "~/hooks/use-role";

// Mock react-router's useRouteLoaderData; each test sets the return value.
const mockLoaderData = vi.fn();
vi.mock("react-router", () => ({
  useRouteLoaderData: (...args: unknown[]) => mockLoaderData(...args),
}));

/** Probe component that surfaces both hook results as data attributes. */
function Probe() {
  const role = useRole();
  const isConvenor = useIsConvenor();
  return (
    <span data-role={String(role)} data-is-convenor={String(isConvenor)} />
  );
}

function renderProbe() {
  const { container } = render(<Probe />);
  const span = container.querySelector("span")!;
  return {
    role: span.getAttribute("data-role"),
    isConvenor: span.getAttribute("data-is-convenor"),
  };
}

describe("useRole / useIsConvenor", () => {
  beforeEach(() => {
    mockLoaderData.mockReset();
  });

  it("useRole() returns 'convenor' when loader data is { userRole: 'convenor' }", () => {
    mockLoaderData.mockReturnValue({ userRole: "convenor" });
    const { role, isConvenor } = renderProbe();
    expect(role).toBe("convenor");
    expect(isConvenor).toBe("true");
  });

  it("useRole() returns 'collaborator' when loader data is { userRole: 'collaborator' }", () => {
    mockLoaderData.mockReturnValue({ userRole: "collaborator" });
    const { role, isConvenor } = renderProbe();
    expect(role).toBe("collaborator");
    expect(isConvenor).toBe("false");
  });

  it("useRole() returns null when loader data is null", () => {
    mockLoaderData.mockReturnValue(null);
    const { role, isConvenor } = renderProbe();
    expect(role).toBe("null");
    expect(isConvenor).toBe("false");
  });

  it("useRole() returns null when userRole is absent from loader data", () => {
    mockLoaderData.mockReturnValue({ somethingElse: 1 });
    const { role, isConvenor } = renderProbe();
    expect(role).toBe("null");
    expect(isConvenor).toBe("false");
  });

  it("useRole() reads from the routes/_app loader id", () => {
    mockLoaderData.mockReturnValue({ userRole: "convenor" });
    renderProbe();
    expect(mockLoaderData).toHaveBeenCalledWith("routes/_app");
  });
});
