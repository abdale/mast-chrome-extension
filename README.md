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
2. Click the mast extension icon and click **Enable Captions** to instantly turn on live captions inside Teams.
3. Click **Start AI Notes**. The extension will passively collect captions.
4. When the meeting ends (or when you click **Stop**), the extension automatically downloads both your raw transcript (`.txt`) and your AI-generated meeting summary (`.md`).
5. You can also open the popup after the session to manually trigger or re-download either file:
   - **Generate AI Summary**: Sends the transcript to Google AI Studio and downloads a formatted Markdown (`.md`) file with an AI-generated title.
   - **Download Transcript**: Downloads a raw text (`.txt`) file containing the speaker captions.
6. Click **End Session** to clear the captured transcript and start fresh for a new meeting.
