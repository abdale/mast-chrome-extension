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
   - Select the `extension/` folder from this repository.
   - The "mast" extension will appear in your browser toolbar.

2. **Configure the Extension**
   - Click the "mast" extension icon in your toolbar.
   - Paste your Google AI Studio API Key into the popup to dynamically load the latest stable Gemini Flash Lite model as your default.
   - Click the ⚙️ icon to open **Settings** if you'd like to choose a different model (e.g., standard Gemini Flash or a custom model).

---

## Usage Guide
1. Join a browser-based Microsoft Teams meeting.
2. Click the mast extension icon and click **Enable Captions** to instantly turn on live captions inside Teams.
3. Click **Start AI Notes**. The extension will passively collect captions.
4. When ready, click **Stop Transcript**.
5. You can now download your meeting notes in two formats:
   - **Generate AI Summary**: Sends the data to Google AI Studio and automatically downloads a beautifully formatted Markdown (`.md`) file. The filename and internal heading will dynamically include a short, AI-generated title based on the meeting context.
   - **Download Transcript**: Downloads a raw text (`.txt`) file containing a timestamped log of the speaker captions.
6. Click **End Session** to clear the captured transcript and start fresh for a new meeting.
