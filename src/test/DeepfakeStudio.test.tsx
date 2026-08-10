import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import DeepfakeStudio from "@/components/DeepfakeStudio";

describe("DeepfakeStudio", () => {
  it("renders without crashing", async () => {
    render(<DeepfakeStudio />);
    await screen.findByRole("button", { name: /start/i });
  });

  it("shows preview backend error message when API key is missing", async () => {
    const user = userEvent.setup();
    render(
      <DeepfakeStudio
        apiKey=""
        enableFallback={true}
        onPreviewError={() => console.log("preview error")}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start/i }));

    expect(screen.getByText(/check key\/capacity/i)).toBeInTheDocument();
  });

  it("falls back to live connection when preview backend fails", async () => {
    const onLiveConnection = vi.fn();
    render(
      <DeepfakeStudio
        apiKey=""
        enableFallback={true}
        onPreviewError={() => console.log("preview error")}
        onLiveConnection={onLiveConnection}
      />,
    );

    await screen.findByRole("button", { name: /start/i });

    expect(onLiveConnection).toHaveBeenCalled();
  });

  it("displays toast when preview backend unavailable", async () => {
    const user = userEvent.setup();
    render(
      <DeepfakeStudio
        apiKey=""
        enableFallback={true}
        onPreviewError={() => console.log("preview error")}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start/i }));

    expect(screen.getByText(/preview backend unavailable/i)).toBeInTheDocument();
  });

  it("shows success message when preview backend succeeds", async () => {
    const user = userEvent.setup();
    render(
      <DeepfakeStudio
        apiKey="test-key"
        enableFallback={true}
        onPreviewError={() => console.log("preview error")}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start/i }));

    expect(screen.getByText(/preview running/i)).toBeInTheDocument();
  });
});