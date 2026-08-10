---
name: deepfake-studio-development
description: Guidelines for developing and debugging the real-time face swap pipeline
applyTo:
  - "src/components/DeepfakeStudio.tsx"
  - "src/hooks/useDecartRealtime.ts"
  - "src/workers/obsEncoder.worker.ts"
  - "src/lib/lucyPromptGuard.ts"
---

# DeepfakeStudio Real-Time Video Processing Skill

This skill provides guidance for working with Elite Swap's core feature: real-time AI face-swap streaming.

## Architecture Overview

### Component Hierarchy
```
DeepfakeStudio (master component)
├── useDecartRealtime (Decart API integration)
│   └── Calls buildPromptWithIdentityGuard
├── obsEncoder.worker (Web Worker for H.264 encoding)
└── UI Controls (character selection, quality settings, etc.)
```

### Data Flow
1. **Capture**: Browser `MediaDevices.getUserMedia()` captures webcam
2. **Process**: Frame → Decart API (with guarded prompt) → AI-processed frame
3. **Encode**: Worker thread H.264-encodes frame; falls back to JPEG if unsupported
4. **Stream**: Encoded frame POSTed to OBS HTTP endpoint on localhost
5. **Display**: Browser shows live preview (canvas) + OBS shows on broadcast

## Key Implementation Details

### Prompt Guarding
All user prompts are processed through `lucyPromptGuard`:
```typescript
import { buildPromptWithIdentityGuard } from "@/lib/lucyPromptGuard";
const guardedPrompt = buildPromptWithIdentityGuard(userInput);
```

**What it does**:
- Appends "preserve reference face identity" to prevent face morphing
- Adds negative prompts (avoid nudity, glitching, watermarks, etc.)
- Truncates to 2200 chars if needed

**When modifying**: Update tests in `lucyPromptGuard.test.ts` to validate behavior

### Decart API Integration
`useDecartRealtime` handles:
- Authentication with Decart API key (from `.env`)
- Frame submission + polling for results (async inference)
- Error recovery (auto-retry on network timeout)
- Context cleanup on unmount

**Common Issues**:
- API key missing or expired → check `.env.local`
- Rate limiting (too many frames/sec) → Decart returns 429; client backs off
- Inference timeout → frame skipped, next frame processed

### Web Worker Encoding
`obsEncoder.worker.ts` runs in a separate thread to avoid blocking UI:
- Attempts H.264 encoding (faster, smaller payload)
- Falls back to JPEG if `WebCodecs` API unavailable
- Handles frame format conversion (RGBA → codec-specific format)

**Debugging**:
- Check browser console for "H.264 init failed" or "reconfigure failed" warnings
- If frequent fallback: browser doesn't support WebCodecs (older Chrome, Safari)
- JPEG fallback produces larger files but still works for OBS

### Lite Mode (Device Detection)
For low-end devices:
- Auto-detects performance via frame processing latency
- Reduces inference resolution or skips frames
- URL param `?hi=1` forces full quality (testing)

## Common Development Tasks

### Adding a New Character Preset
1. **Define** preset data in `CharacterPresets.tsx`
2. **Test** with DeepfakeStudio by selecting preset
3. **Verify** prompt guard doesn't strip important styling keywords
4. **Update** `lucyPromptGuard.test.ts` if needed (e.g., new keywords to preserve)

### Adjusting Prompt Filtering
1. **Edit** `IDENTITY_LOCK_SUFFIX` or `NEGATIVE_PROMPT_SUFFIX` in `lucyPromptGuard.ts`
2. **Run** tests: `npm run test lucyPromptGuard`
3. **Verify** with real input: check `buildPromptWithIdentityGuard()` output in browser console
4. **Update** test cases to match new expectations

### Debugging OBS Stream Failures
1. **Check** URL format: `http://localhost:8080/api/stream/{sessionId}`
2. **Verify** DeepfakeStudio mounted (not unmounted early)
3. **Check** Network tab: POST requests to `/api/stream/` should return 200
4. **OBS Config**: VLC Video Source → Network URL = Elite Swap stream endpoint
5. **Firewall**: Ensure OBS machine can reach Vite dev server (localhost:8080)

### Performance Optimization
**Bottlenecks**:
- Decart API inference latency (network + AI processing) ~ 100-500ms
- Encoding latency (H.264 in worker) ~ 50-150ms
- Total frame latency: 150-650ms typical

**Optimization strategies**:
- Increase frame skip ratio if latency > 500ms (trade quality for responsiveness)
- Use Lite mode on low-end devices
- Pre-warm Decart API connection (send dummy frame on mount)
- Consider regional Decart inference endpoint (if available)

## Testing

### Unit Tests
```bash
npm run test lucyPromptGuard  # Test prompt filtering
npm run test -- --watch      # Watch mode for development
```

### Integration Testing
1. **Start dev server**: `npm run dev`
2. **Open studio**: http://localhost:8080/studio
3. **Accept terms** if required
4. **Test** video capture, preset switching, OBS streaming
5. **Monitor** console for errors/warnings

### Manual QA Checklist
- [ ] Video preview displays in real-time
- [ ] Character preset changes apply immediately
- [ ] Prompt is sanitized (check console)
- [ ] OBS receives HTTP stream (check network tab)
- [ ] Fallback to JPEG on unsupported H.264
- [ ] Lite mode activates on low-end devices
- [ ] Terms gate shows before first studio access

## Important Notes

### Compliance & Safety
- **Prompt Guarding**: Always apply guards to prevent misuse (nudity, identity morphing)
- **Terms Acceptance**: Required before studio access; audit-logged in database
- **User Consent**: Ensure prompts only modify user's own face/content
- **Rate Limiting**: Decart API enforces limits; client should respect backoff

### Known Limitations
- **Browser Support**: WebCodecs API not available in older browsers (Safari, older Chrome)
- **Latency**: Real-time inference inherently has 100-500ms+ latency
- **Resolution**: Limited by browser Media Devices API (typically 720p-1080p max)
- **OBS Integration**: Requires manual HTTP URL configuration in OBS (no auto-discovery)

## References
- [Decart AI SDK](https://docs.decart.ai/)
- [Web Codecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- [MediaDevices.getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [OBS Scripting](https://obsproject.com/wiki/Scripting-Tutorial)
