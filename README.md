# mast (Meeting AI Summarizer & Transcriber)

A lightweight Chrome Extension that smoothly transcribes browser-based Microsoft Teams meetings and generates AI-powered meeting minutes using Google AI Studio (Gemini).

## How it works
This extension uses a seamless, zero-audio approach. It relies on the MS Teams "Live Captions" feature, utilizing a DOM scraper to capture the text and speaker names securely into your browser's local storage. The extension then talks directly to the Google AI Studio API (using your personal API key) to process the transcript through Gemini 2.5 Flash Lite.

---

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
   - Right-click the "mast" extension icon in your toolbar and select **Options**, or click the ⚙️ icon inside the extension popup.
   - Paste your Google AI Studio API Key into the input field.
   - Click **Save Settings**.

---

## Usage Guide
1. Join a browser-based Microsoft Teams meeting.
2. Inside Teams, press `Alt+Shift+C` (or click `More` (...) -> `Language and speech` -> **Turn on live captions**).
3. Click the mast extension icon in your browser toolbar.
4. Click **Start AI Notes**. The extension will passively collect captions.
5. When ready, click **Stop**.
6. Click **Generate AI Summary**. The extension will send the data to Google AI Studio and download a beautifully formatted `.txt` file containing your meeting summary and action items.
