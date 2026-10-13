# mast (Meeting AI Summarizer & Transcriber)

A lightweight Chrome Extension that smoothly transcribes browser-based Microsoft Teams meetings and generates AI-powered meeting minutes using Google AI Studio (Gemini).

## Setup Instructions

### Part 1: Get a Google AI Studio API Key

To use the AI generation features securely without maintaining a backend, the extension uses a Bring-Your-Own-Key (BYOK) model.

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Sign in with your Google account.
3. Click on **Get API Key** and create a new key.
4. Copy the API key to your clipboard.

### Part 2: Installing the Chrome Extension

1. **Load into Chrome**
   - Open Google Chrome and navigate to `chrome://extensions/`.
   - Toggle **Developer mode** ON (top right corner).
   - Click the **Load unpacked** button.
   - Select the `mast-extension/` folder from this repository.
   - The "mast" extension will appear in your browser toolbar.

2. **Configure the Extension**
   - Click the "mast" extension icon in your toolbar.
   - Paste your Google AI Studio API Key into the popup to dynamically load the latest stable Gemini Flash model as your default.
   - Click **Settings** in the popup if you'd like to select between the last two stable Gemini Flash models or specify a custom model ID.

---

## Usage Guide
1. Join a browser-based Microsoft Teams meeting.
2. Click the mast extension icon and click **Capture Meeting Notes**. Live captions will automatically be enabled in Teams and the extension will passively collect captions.
3. When the meeting ends (or when you click **Stop**), the extension automatically generates and downloads both your AI meeting summary (`.md`) and raw transcript (`.txt`) to your Downloads folder.
