import { beforeEach, describe, expect, it } from "vitest";
import { get } from "./storeCompat";
import {
  clearProjectPanelState,
  getProjectPanelStateStore,
} from "./projectPanelState";

describe("project panel state", () => {
  beforeEach(() => clearProjectPanelState());

  it("keeps the same panel value when returning to a project", () => {
    const first = getProjectPanelStateStore("project-a", "toolbox.json", "");
    first.set('{"kept":true}');

    expect(
      get(getProjectPanelStateStore("project-a", "toolbox.json", "")),
    ).toBe('{"kept":true}');
  });

  it("isolates the same panel between projects", () => {
    getProjectPanelStateStore(
      "project-a",
      "review.file",
      null as string | null,
    ).set("src/a.ts");
    getProjectPanelStateStore(
      "project-b",
      "review.file",
      null as string | null,
    ).set("src/b.ts");

    expect(
      get(getProjectPanelStateStore("project-a", "review.file", null)),
    ).toBe("src/a.ts");
    expect(
      get(getProjectPanelStateStore("project-b", "review.file", null)),
    ).toBe("src/b.ts");
  });
});
