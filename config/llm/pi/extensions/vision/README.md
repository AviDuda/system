# Vision Extension

Routes image reads to a vision-capable sidecar model when the main model doesn't support images.

## How it works

1. On session start / model change, checks if the current model supports image input (`input: ["text", "image"]`)
2. If the model is text-only:
   - Shows `eye:on` footer status
   - Registers a `describe_image` tool the model can call explicitly
   - Intercepts `read` tool results containing images and replaces them with text descriptions from the vision sidecar
3. If the model supports images natively, the extension is completely inactive

## Configuration

The `vision` role in `~/.pi/agent/roles.json` configures which vision model to use:

```json
{
  "vision": {
    "models": [{ "ref": "zai/glm-4.6v-flash", "thinking": "off" }]
  }
}
```

Change via `/sidecar-models` → select the `vision` role.

## `describe_image` tool

The model can call this explicitly for targeted analysis:

```
describe_image(path="/path/to/screenshot.png", prompt="Extract the text from this terminal screenshot")
```

