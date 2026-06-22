# MS Teams AI Minutes

A lightweight Chrome Extension that smoothly transcribes browser-based Microsoft Teams meetings and generates AI-powered meeting minutes using Google Cloud Gemini Enterprise Agent Platform.

## How it works
This extension uses a seamless, zero-audio approach. It relies on the MS Teams "Live Captions" feature, utilizing a DOM scraper to capture the text and speaker names securely into your browser's local storage. A secure Google Cloud Function acts as the backend to process the transcript through Gemini Enterprise Agent Platform.

---

## Setup Instructions

### Part 1: Deploying the Google Cloud Function (Agent Platform Backend)

To keep credentials secure, the extension talks to a Cloud Function, which in turn authenticates with Gemini Enterprise Agent Platform.

1. **Create a Google Cloud Project**
   - Go to the [Google Cloud Console](https://console.cloud.google.com/).
   - Create a new project or select an existing one.
   - Enable billing for the project.

2. **Enable Required APIs (No Manual Endpoint Required)**
   - Navigate to **APIs & Services > Library**.
   - Search for and enable the **Agent Platform API**.
   - Search for and enable the **Cloud Functions API** and **Cloud Build API**.
   - *Note on Endpoints:* Because we are using Google's managed Gemini model (`gemini-3.5-flash`), **you do not need to manually create or deploy an Agent Platform Endpoint**. Enabling the API gives the Cloud Function direct access to Google's pre-deployed Enterprise endpoint.

3. **Deploy the Function**
   - Open the **Cloud Shell** (terminal icon in the top right of the GCP console).
   - Clone this repository (or copy the `backend` folder files).
   - Navigate to the backend directory: `cd backend`
   - Run the following command to deploy the function:
     ```bash
     gcloud functions deploy generate-teams-minutes \
       --runtime nodejs20 \
       --trigger-http \
       --allow-unauthenticated \
       --entry-point generateMinutes \
       --region us-central1 \
       --set-env-vars GCP_PROJECT=YOUR_PROJECT_ID
     ```
   - *Note: `--allow-unauthenticated` allows the Chrome extension to call the endpoint. For production, consider implementing an API Key or Firebase Auth verification inside the function.*

   > **Troubleshooting Build Errors:** If you encounter a `missing permission on the build service account` error during deployment, run these commands in your Cloud Shell to fix it:
   > ```bash
   > export PROJECT_ID=$(gcloud config get-value project)
   > export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
   > gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="roles/cloudbuild.builds.builder"
   > gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="roles/artifactregistry.writer"
   > ```
   > Then try deploying again.

4. **Grant Agent Platform Permissions**
   - Go to **IAM & Admin > IAM**.
   - Find the Default App Engine service account (usually `YOUR_PROJECT_ID@appspot.gserviceaccount.com`).
   - Edit the principal and add the role: **Agent Platform User**.

5. **Copy the Trigger URL**
   - Once deployed, the console will output an `httpsTrigger` URL (e.g., `https://us-central1-YOUR-PROJECT.cloudfunctions.net/generate-teams-minutes`).
   - Copy this URL. You will need it for the Chrome extension.

---

### Part 2: Installing the Chrome Extension

1. **Configure the Extension**
   - Open `extension/popup.js` in a text editor.
   - Locate the `CLOUD_FUNCTION_URL` variable at the top of the file.
   - Paste the Trigger URL you copied from Google Cloud. Save the file.

2. **Load into Chrome**
   - Open Google Chrome and navigate to `chrome://extensions/`.
   - Toggle **Developer mode** ON (top right corner).
   - Click the **Load unpacked** button.
   - Select the `extension/` folder from this repository.
   - The "Teams AI Minutes" extension will appear in your browser toolbar.

---

## Usage Guide
1. Join a browser-based Microsoft Teams meeting.
2. Inside Teams, click `More` (...) -> `Language and speech` -> **Turn on live captions**.
3. Click the Teams AI Minutes extension icon in your browser toolbar.
4. Click **Start Transcribing**. The extension will passively collect captions.
5. When ready, click **Stop Transcribing**.
6. Click **Generate Minutes**. The extension will send the data to Gemini Enterprise Agent Platform and download a formatted `.txt` file containing your meeting summary and action items.
