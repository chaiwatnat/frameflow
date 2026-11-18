# Frameflow · local image-to-video studio

A responsive web UI for the supplied **MiniMax_H3_I2V_Balanced.json**, connected to ComfyUI at **http://127.0.0.1:8188**.

## Run

1. Start ComfyUI with the models and nodes required by your supplied workflow.
2. Install Node.js **22 or newer** if needed.
3. Double-click **start.bat**, or open a terminal in this folder and run:

   npm start

4. Open **http://127.0.0.1:3000**.

No npm dependencies or install step are required. Keep the terminal open while using the studio.

To use a different UI port or backend in PowerShell:

    $env:PORT = "3001"
    $env:COMFYUI_URL = "http://127.0.0.1:8188"
    npm start

## Use

- Upload or drag in one PNG, JPG, or WebP image, up to 20 MB.
- Write a prompt containing **5–300 whitespace-separated words**.
- Choose a duration of **5–15 seconds**, default **10 seconds**.
- Choose **0.4M, 0.6M, 0.8M, or 1.0M**, default **0.8M**.
- Generate, watch live node/sampling progress, and preview or download the result.
- Recent completed videos are remembered in this browser. The actual files stay in ComfyUI's output directory.
- An active job is restored when refreshing the same browser tab. HTTP history polling also works when WebSocket updates are unavailable.
- Click the backend connection indicator to refresh connectivity. Click the information icon for workflow details.

The app binds to 127.0.0.1. HTTP and WebSocket requests pass through the local server, so ComfyUI does not need CORS flags.

## Workflow mapping

The original JSON is read from disk at startup and is never rewritten. Each submission clones its output graph and changes only these inputs:

| UI value | Node | Input |
| --- | --- | --- |
| Uploaded image | 114 · LoadImage | image |
| Text prompt | 105:104 · MiniMaxH3ImageToVideo | prompt |
| Duration | 105:111 · PrimitiveFloat | value |
| Resolution | 115 · ResolutionSelector | megapixels |
| New random seed | 105:15 · RandomNoise | noise_seed |

The supplied square aspect ratio, 32-pixel dimension multiple, models, audio branch, 24 fps, 8-step Lightning LoRA configuration, and SaveVideo destination are preserved.

The supplied duration expression snaps to MiniMax H3's **17k+5** frame grid:

    base = max(5, round(seconds * 24))
    frames = base + (5 - base % 17) % 17

For example, 10 seconds means **243 frames / 24 fps = 10.125 seconds**. The UI reports actual duration once the video completes. 0.8M produces **928 × 928** using the workflow's 1024² megapixel convention and 32-pixel rounding.

The supplied nodes 119 (ImageScaleToTotalPixels) and 120 (GetImageSize) are disconnected from SaveVideo; node 119 has no image input. These unused nodes are excluded from the submitted graph. Output dimensions come from node 115, which is connected to the generator.

The backend verifies required node types and model availability. ComfyUI remains responsible for workflow validation and execution; its node errors are shown in the UI.

## Verification

    npm test

Tests cover exact graph bindings, input bounds, temporal snapping, original-template immutability, output parsing, proxy behavior, and a complete upload → queue → history → downloadable-video flow against a mock ComfyUI backend.

API references: [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes) and [ComfyUI WebSocket messages](https://docs.comfy.org/development/comfyui-server/comms_messages).
