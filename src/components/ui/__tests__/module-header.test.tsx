// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { PROJECTS_MODULE } from "@/app/module-nav";

afterEach(cleanup);

describe("ModuleHeader", () => {
  it("the workspace variant is a plain title and one line of context: no icon chip, gradient or shadow", () => {
    const { container } = render(<ModuleHeader variant="workspace" module={PROJECTS_MODULE}>Context line</ModuleHeader>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Projects");
    expect(screen.getByText("Context line")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.innerHTML).not.toMatch(/gradient|shadow/);
  });
  it("the Toolbox variant (the default) keeps its icon chip", () => {
    const { container } = render(<ModuleHeader module={PROJECTS_MODULE}>Context line</ModuleHeader>);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
