import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CallModePanel } from "./CallModePanel";

describe("CallModePanel", () => {
  it("shows only the switch and blurb while off", () => {
    render(<CallModePanel enabled={false} onChange={() => {}} ios connected={false} />);
    expect(screen.getByText(/Your voice stays in the call/)).toBeTruthy();
    expect(screen.queryByText("Telegram")).toBeNull();
  });

  it("lists the apps and switches the steps per app when on", () => {
    render(<CallModePanel enabled onChange={() => {}} ios connected={false} />);
    expect(screen.getByText("FaceTime")).toBeTruthy();
    expect(screen.getByText(/Open WhatsApp and start a video call/)).toBeTruthy();
    fireEvent.click(screen.getByText("Telegram"));
    expect(screen.getByText(/Open Telegram and start a video call/)).toBeTruthy();
  });

  it("asks for a reconnect when turned on mid-session, and reports the switch", () => {
    const onChange = vi.fn();
    render(<CallModePanel enabled onChange={onChange} ios={false} connected />);
    expect(screen.getByText(/Disconnect and connect again/)).toBeTruthy();
    expect(screen.queryByText("FaceTime")).toBeNull();
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
