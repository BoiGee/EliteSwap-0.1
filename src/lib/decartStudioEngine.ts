import { createDecartClient, models } from "@decartai/sdk";
import { buildPromptWithIdentityGuard } from "@/lib/lucyPromptGuard";

// A hung fetch to Decart otherwise blocks submit() forever: the preview
// loop's tick() never resolves, so it can never fall through to a retry
// or the offline fallback, and the output panel is stuck showing
// "Starting renderer..." indefinitely while the session timer keeps billing.
const SUBMIT_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export interface DecartStudioConfig {
  apiKey?: string;
  mode?: "preview" | "batch" | "live" | string;
  enableFallback?: boolean;
}

export interface DecartStudioRequest {
  prompt: string;
  mode?: string;
  imageUrl?: string | null;
  width?: number | null;
  height?: number | null;
  extra?: Record<string, unknown> | null;
}

export interface DecartStudioResponse {
  success: boolean;
  outputUrl: string | null;
  requestId: string | null;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  error?: string | null;
}

export class DecartStudioEngine {
  private readonly apiKey: string;
  private readonly mode: string;
  private readonly enableFallback: boolean;

  constructor(config: DecartStudioConfig = {}) {
    const runtimeConfig = this.readRuntimeConfig();
    this.apiKey = config.apiKey || runtimeConfig.apiKey || import.meta.env.VITE_DECART_API_KEY || "";
    this.mode = (config.mode || runtimeConfig.mode || "preview").toLowerCase();
    this.enableFallback = config.enableFallback ?? runtimeConfig.enableFallback ?? true;
  }

  private readRuntimeConfig(): DecartStudioConfig {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem("elite-decart-studio-config");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private normalizeMode(mode?: string): string {
    return (mode || "preview").trim().toLowerCase() || "preview";
  }

  // The captured frame comes in as a data: URL; the SDK's own file-input
  // coercion only accepts http(s) URLs for strings, so decode it ourselves.
  private async toBlob(source: string): Promise<Blob> {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to read source frame (${response.status})`);
    return response.blob();
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(new Error("Failed to read generated image"));
      reader.readAsDataURL(blob);
    });
  }

  public async submit(request: DecartStudioRequest): Promise<DecartStudioResponse> {
    const mode = this.normalizeMode(request.mode || this.mode);
    // Enforced here too, not just at the call sites that currently guard
    // before calling submit() — this is idempotent (a already-guarded
    // prompt passes through unchanged), so it's a safety net for any future
    // caller that forgets to pre-guard, not a behavior change today.
    const prompt = buildPromptWithIdentityGuard(request.prompt);

    if (!this.apiKey.trim()) {
      if (!this.enableFallback) {
        return this.buildFallbackResponse(mode, prompt, "API key missing and fallback disabled", false);
      }
      return this.buildFallbackResponse(mode, prompt, "Missing API key; running preview-only");
    }

    if (!request.imageUrl) {
      return this.buildFallbackResponse(mode, prompt, "No source frame available");
    }

    try {
      const client = createDecartClient({ apiKey: this.apiKey });
      const sourceBlob = await this.toBlob(request.imageUrl);
      const outputBlob = await withTimeout(
        client.process({
          model: models.image("lucy-image-2"),
          prompt,
          data: sourceBlob,
        }),
        SUBMIT_TIMEOUT_MS,
        "Decart request",
      );
      const outputUrl = await this.blobToDataUrl(outputBlob);

      return {
        success: true,
        outputUrl,
        requestId: null,
        data: { mode, prompt },
        metadata: { mode, source: "decart-image-edit" },
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown studio error";
      return this.buildFallbackResponse(mode, prompt, message);
    }
  }

  private buildFallbackResponse(
    mode: string,
    prompt: string,
    error: string,
    success: boolean = mode === "preview" || mode === "batch"
  ): DecartStudioResponse {
    return {
      success,
      outputUrl: null,
      requestId: null,
      data: {
        mode,
        prompt,
        fallback: "offline_credit_safe",
      },
      metadata: {
        credit_safe: true,
        mode,
        offline_fallback: true,
        error,
        lucy25: mode === "preview",
      },
      error,
    };
  }
}
